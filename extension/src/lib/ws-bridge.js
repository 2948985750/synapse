"use strict";
// Agent WS bridge: this service worker dials OUT to the local agent.
//
// Why outbound: a browser can always open a loopback WebSocket, it needs no
// registry or helper process, and an open socket keeps the MV3 worker alive.
// One port per agent session is probed; a port that fails before ever opening
// is cooled down so a reconnect storm cannot exhaust the network buffers.
//
// Everything the bridge needs is injected (chrome, WebSocket, HMAC auth module,
// command executor, lease/capture bookkeeping), which keeps it testable in node.

const DEFAULT_TIMINGS = {
  authWaitMs: 5000, // a fresh socket may take this long to finish the handshake
  dialWatchdogMs: 10000, // SYN_SENT can hang on loopback; force-close after this
  dialCooldownMs: 15000, // a port that never opened is not retried for this long
  pingIntervalMs: 20000, // keepalive while at least one bridge is connected
  rescanIntervalMs: 5000, // re-probe cadence while no bridge is connected
};

function createWsBridge(deps = {}) {
  const chromeApi = deps.chromeApi || globalThis.chrome;
  // Resolved per call: the node tests swap global.WebSocket between cases.
  const wsCtor = () => deps.WebSocketImpl || globalThis.WebSocket;
  const WSAuth = deps.wsAuth;
  const execAgentCmd = deps.execAgentCmd;
  const captureSessions = deps.captureSessions;
  const stopCapture = deps.stopCapture;
  const clientLeases = deps.clientLeases;
  const releaseLease = deps.releaseLease;
  const log = deps.log || (() => {});
  const MAX_FRAME_CHARS = deps.maxFrameChars || 1 << 20; // 1M chars ≈ 1MB of JSON
  const {
    authWaitMs: AUTH_WAIT_MS,
    dialWatchdogMs: DIAL_WATCHDOG_MS,
    dialCooldownMs: DIAL_COOLDOWN_MS,
    pingIntervalMs: PING_INTERVAL_MS,
    rescanIntervalMs: RESCAN_INTERVAL_MS,
  } = { ...DEFAULT_TIMINGS, ...(deps.timings || {}) };

// ---------------- agent WS bridge (primary channel) ----------------
// The channel is the REVERSED one: agent apps run a loopback WebSocket server
// (agent-collect.js) and THIS worker dials OUT to it. Outbound WS always works from a browser, needs no registry, no
// spawn, and an open socket keeps the MV3 service worker alive.
// T-33: 10 ports were not enough with concurrent sessions (each session's
// serve/--keep bridge plus a one-shot direct connection takes one), so the
// range is now 20. The agent side must match (WB_AGENT_WS_START/END on the
// agent side does not move this array — custom ranges need manual sync).
const AGENT_WS_PORTS = [
  9521, 9522, 9523, 9524, 9525, 9526, 9527, 9528, 9529, 9530, 9531, 9532, 9533,
  9534, 9535, 9536, 9537, 9538, 9539, 9540,
];
/** port -> Set<WebSocket>: one agent server port may hold several sockets
 * at once (a long-lived bridge daemon plus one-shot clients). Each socket
 * owns its lifecycle and result routing; none replaces another. */

const agentWs = new Map();
/** port -> cooldown deadline: a port whose dial never opened is not retried
 * for 15s. During a bridge vacuum the "10 ports × every 5s" rejection storm
 * piled up sockets and exhausted Edge's network buffers (T-32 incident:
 * ERR_NO_BUFFER_SPACE + SYN_SENT stuck). */
const portCooldown = new Map();
const wsClientOwners = new Map(); // clientId -> authenticated socket; prevents cross-bridge lease collisions
let wsRescanTimer = null;
let wsPingTimer = null;
let bridgeToken = null;
let tokenLoaded = false;
let connectingAgentWs = null;

function loadBridgeToken() {
  // The auth token is a fixed constant built into both sides (ws-auth.js
  // DEFAULT_TOKEN): no storage, no user pairing — update both sides together.
  return new Promise((resolve) => {
    bridgeToken = WSAuth.DEFAULT_TOKEN;
    tokenLoaded = true;
    resolve(bridgeToken);
  });
}

function disconnectClient(ws, clientId, releaseLeases) {
  ws.__disconnecting ||= new Map();
  if (ws.__disconnecting.has(clientId)) return ws.__disconnecting.get(clientId);
  ws.__clients?.delete(clientId);
  const pending = [];
  for (const request of ws.__requests?.values() || []) {
    if (request.clientId !== clientId) continue;
    if (!request.started) request.cancelled = true;
    if (request.completion) pending.push(request.completion);
  }
  const cleanup = (async () => {
    await Promise.allSettled(pending);
    await Promise.allSettled(
      [...captureSessions.values()]
        .filter((s) => s.clientId === clientId && s.ws === ws)
        .map((s) => stopCapture(s.captureId)),
    );
    // Another socket is never permitted to claim this identity until cleanup
    // completes, including when pairing rotates or the bridge reconnects.
    if (releaseLeases && wsClientOwners.get(clientId) === ws) {
      for (const tabId of [...(clientLeases.get(clientId) || [])])
        await releaseLease(clientId, tabId);
    }
    if (wsClientOwners.get(clientId) === ws) wsClientOwners.delete(clientId);
  })().finally(() => ws.__disconnecting.delete(clientId));
  ws.__disconnecting.set(clientId, cleanup);
  return cleanup;
}

function claimWsClient(ws, clientId) {
  const owner = wsClientOwners.get(clientId);
  if (owner && owner !== ws)
    throw new Error("clientId is active on another connection");
  wsClientOwners.set(clientId, ws);
}

// WS channel diagnostics (persisted to chromeApi.storage.local.wbWsLog, last
// 40). Used to debug "agent runs the server but the extension cannot
// connect": reload the extension, then read the leveldb entry.
function wsLog(line) {
  try {
    chromeApi.storage.local.get(["wbWsLog"], (res) => {
      const arr = (res?.wbWsLog || []).concat([
        new Date().toISOString().slice(5, 24) + " " + line,
      ]);
      chromeApi.storage.local.set({ wbWsLog: arr.slice(-40) });
    });
  } catch (_) {}
}

function agentWsPortsUp() {
  return [...agentWs.entries()]
    .filter(([, set]) =>
      [...set].some(
        (ws) => ws.readyState === wsCtor().OPEN && ws.__authenticated,
      ),
    )
    .map(([p]) => p);
}

// Send to one specific socket (result routing: a cmd is answered on the
// socket that issued it; other sockets on the same port are unaffected).
// Best-effort: dropped when the socket is gone.
function wsSendTo(ws, obj) {
  if (ws && ws.readyState === wsCtor().OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      log("warn", "ws send failed", { error: String(e) });
    }
  }
  return false;
}

// Broadcast to every OPEN socket on a port (ping / welcome: session-agnostic)
function sendWs(port, obj) {
  let sent = false;
  const set = agentWs.get(port);
  if (set) for (const ws of set) sent = wsSendTo(ws, obj) || sent;
  return sent;
}

async function onWsMessage(ws, port, raw) {
  // Bound the frame before parsing: no command needs a megabyte of JSON, and
  // JSON.parse on a hostile frame is pure CPU inside the service worker.
  if (typeof raw === "string" && raw.length > MAX_FRAME_CHARS) {
    wsLog("port " + port + " FRAME TOO LARGE (" + raw.length + " chars)");
    try {
      ws.close();
    } catch (_) {}
    return;
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (!m || typeof m !== "object" || ws.__retired) return;
  if (m.type === "auth.challenge" && !ws.__authenticated) {
    if (
      ws.__auth ||
      m.protocol !== WSAuth.PROTOCOL ||
      !WSAuth.validToken(m.nonce) ||
      !bridgeToken
    ) {
      ws.close();
      return;
    }
    const auth = {
      serverNonce: m.nonce,
      clientNonce: WSAuth.createNonce(),
      token: bridgeToken,
    };
    ws.__auth = auth;
    try {
      const proof = await WSAuth.sign(
        auth.token,
        "extension",
        "client",
        auth.serverNonce,
        auth.clientNonce,
      );
      if (ws.__retired) return;
      wsSendTo(ws, {
        type: "auth.response",
        protocol: WSAuth.PROTOCOL,
        role: "extension",
        nonce: auth.clientNonce,
        proof,
        extId: chromeApi.runtime?.id,
      });
    } catch (_) {
      ws.close();
    }
    return;
  }
  if (m.type === "auth.ok" && !ws.__authenticated) {
    const auth = ws.__auth;
    if (
      !auth ||
      m.protocol !== WSAuth.PROTOCOL ||
      !(await WSAuth.verify(
        auth.token,
        "extension",
        "server",
        auth.serverNonce,
        auth.clientNonce,
        m.proof,
      )) ||
      ws.__retired
    ) {
      ws.close();
      return;
    }
    ws.__authenticated = true;
    ws.__auth = null;
    clearTimeout(ws.__authTimer);
    log("info", "agent ws authenticated", { port });
    return;
  }
  if (!ws.__authenticated) {
    ws.close();
    return;
  }
  if (m.type === "cmd" || m.type === "agent.cmd") {
    const { id, cmd, args, clientId, deadlineAt, transientClient } = m;
    if (typeof cmd !== "string" || !cmd.trim()) {
      wsSendTo(ws, {
        type: "agent.result",
        id,
        ok: false,
        error: "invalid command: cmd must be a non-empty string",
      });
      return;
    }
    if (args != null && (typeof args !== "object" || Array.isArray(args))) {
      wsSendTo(ws, {
        type: "agent.result",
        id,
        ok: false,
        error: "invalid command: args must be an object",
      });
      return;
    }
    if (
      typeof id !== "string" ||
      typeof clientId !== "string" ||
      !clientId ||
      (deadlineAt != null && !Number.isFinite(deadlineAt))
    ) {
      wsSendTo(ws, {
        type: "agent.result",
        id,
        ok: false,
        error: "invalid command identity or deadline",
      });
      return;
    }
    ws.__requests ||= new Map();
    ws.__clients ||= new Map();
    if (ws.__requests.has(id)) {
      wsSendTo(ws, {
        type: "agent.result",
        id,
        ok: false,
        error: "duplicate in-flight request id",
      });
      return;
    }
    ws.__clients.set(clientId, transientClient !== false);
    const priorCleanup = ws.__disconnecting?.get(clientId);
    const ctx = {
      ws,
      wsPort: port,
      clientId,
      deadlineAt,
      cancelled: false,
      started: false,
      authenticationRequired: true,
      completion: null,
    };
    ws.__requests.set(id, ctx);
    ctx.completion = Promise.resolve()
      .then(async () => {
        if (priorCleanup) await priorCleanup;
        if (ws.__retired || !ws.__authenticated)
          throw new Error("command connection is no longer authenticated");
        if (ctx.cancelled || (deadlineAt != null && Date.now() >= deadlineAt))
          throw new Error(
            "command cancelled or deadline expired before execution",
          );
        claimWsClient(ws, clientId);
        return execAgentCmd(cmd, args, clientId, ctx);
      })
      .then((result) =>
        wsSendTo(ws, { type: "agent.result", id, ok: true, result }),
      )
      .catch((e) =>
        wsSendTo(ws, {
          type: "agent.result",
          id,
          ok: false,
          error: String(e.message || e),
        }),
      )
      .finally(() => ws.__requests.delete(id));
    return ctx.completion;
  }
  if (m.type === "cancel") {
    const ctx = ws.__requests?.get(m.id);
    if (ctx && !ctx.started) ctx.cancelled = true;
    return;
  }
  if (
    m.type === "client.disconnect" &&
    typeof m.clientId === "string" &&
    ws.__clients?.has(m.clientId)
  ) {
    await disconnectClient(ws, m.clientId, m.releaseLeases !== false);
    if (m.id != null)
      wsSendTo(ws, {
        type: "agent.result",
        id: m.id,
        ok: true,
        result: { disconnected: true, clientId: m.clientId },
      });
    return;
  }
  if (m.type === "ping") wsSendTo(ws, { type: "pong", ts: m.ts });
}

async function connectAgentWs() {
  if (connectingAgentWs) return connectingAgentWs;
  connectingAgentWs = (async () => {
    if (typeof wsCtor() === "undefined") return;
    if (!tokenLoaded) await loadBridgeToken();
    if (!bridgeToken) return;
    for (const port of AGENT_WS_PORTS) {
      if (agentWs.get(port)?.size) continue;
      if (Date.now() < (portCooldown.get(port) || 0)) continue;
      let ws;
      try {
        ws = new (wsCtor())("ws://127.0.0.1:" + port);
      } catch (e) {
        portCooldown.set(port, Date.now() + DIAL_COOLDOWN_MS);
        log("warn", "ws dial threw", { port, error: String(e) });
        continue;
      }
      const set = new Set([ws]);
      agentWs.set(port, set);
      ws.__requests = new Map();
      ws.__clients = new Map();
      ws.__authenticated = false;
      ws.__authTimer = setTimeout(() => {
        if (!ws.__authenticated) ws.close();
      }, AUTH_WAIT_MS);
      // Dial watchdog: when SYN_SENT gets stuck (loopback occasionally never
      // returns RST for a dead port, T-32), force-close after 10s so the onclose
      // cooldown runs instead of a dead socket holding the port forever (a
      // non-empty set would skip re-dial).
      ws.__dialTimer = setTimeout(() => {
        if (!ws.__opened) {
          try {
            ws.close();
          } catch (_) {}
        }
      }, DIAL_WATCHDOG_MS);
      ws.onopen = () => {
        ws.__opened = true;
        clearTimeout(ws.__dialTimer);
        if (!wsPingTimer) {
          wsPingTimer = setInterval(() => {
            const ts = Date.now();
            for (const p of agentWsPortsUp()) sendWs(p, { type: "ping", ts });
          }, PING_INTERVAL_MS);
        }
      };
      ws.onmessage = (ev) => {
        // WebCrypto verification yields. Queue handshake frames so a command
        // immediately following auth.ok cannot race that verification.
        ws.__incoming = (ws.__incoming || Promise.resolve())
          .then(async () => {
            if (!ws.__authenticated) await onWsMessage(ws, port, ev.data);
            else
              onWsMessage(ws, port, ev.data).catch(() => {
                try {
                  ws.close();
                } catch (_) {}
              });
          })
          .catch(() => {
            try {
              ws.close();
            } catch (_) {}
          });
      };
      ws.onclose = () => {
        clearTimeout(ws.__authTimer);
        clearTimeout(ws.__dialTimer);
        const wasOpen = ws.__opened === true;
        ws.__opened = false;
        ws.__authenticated = false;
        ws.__retired = true;
        set.delete(ws);
        if (agentWs.get(port) === set && !set.size) agentWs.delete(port);
        // Dial attempts that never opened go into a 15s cooldown (T-32), cutting
        // idle dialing during a bridge vacuum by an order of magnitude. A bridge
        // that dropped after opening is not cooled down: it reconnects in 5s.
        if (!wasOpen) portCooldown.set(port, Date.now() + DIAL_COOLDOWN_MS);
        for (const [clientId, transientClient] of [...ws.__clients])
          disconnectClient(ws, clientId, transientClient).catch((e) =>
            log("warn", "client cleanup failed", { error: String(e) }),
          );
        wsLog("port " + port + " CLOSED");
        scheduleWsRescan();
      };
      ws.onerror = () => {
        // onclose follows and owns the recovery path; this is diagnostics only.
        wsLog("port " + port + " ERROR");
      };
    }
    scheduleWsRescan();
  })();
  try {
    return await connectingAgentWs;
  } finally {
    connectingAgentWs = null;
  }
}

// While no agent WS is open, keep probing every 5s (cheap: connect-refused is
// instant). Once one is open, stop rescanning (open sockets keep the SW alive
// anyway).
// Probe every 5s on a constant cadence (cheap: connect-refused on loopback is
// instant). Keep it at 5s even while an agent is OPEN, so a SECOND / new agent
// server that comes up is picked up promptly. The has-guard in connectAgentWs
// means OPEN ports are never re-dialed (no double-connection), so this is safe.
function scheduleWsRescan() {
  if (wsRescanTimer) return;
  wsRescanTimer = setTimeout(() => {
    wsRescanTimer = null;
    connectAgentWs();
  }, RESCAN_INTERVAL_MS);
}


  function isTokenLoaded() {
    return tokenLoaded;
  }

  async function ensureToken() {
    if (!tokenLoaded) await loadBridgeToken();
    return bridgeToken;
  }

  return {
    agentWs,
    AGENT_WS_PORTS,
    connectAgentWs,
    onWsMessage,
    disconnectClient,
    loadBridgeToken,
    ensureToken,
    isTokenLoaded,
    portsUp: agentWsPortsUp,
    scheduleWsRescan,
    sendWs,
    wsSendTo,
  };
}

const WsBridge = { createWsBridge, DEFAULT_TIMINGS };
if (typeof globalThis !== "undefined") Object.assign(globalThis, WsBridge);
if (typeof module !== "undefined" && module.exports) module.exports = WsBridge;
