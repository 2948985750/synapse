"use strict";
// Synapse — control plane (original implementation).
//
// Architecture mirrors (by role, not by copied code) the ChatGPT extension:
//   1. CDP bridge    — chrome.debugger.attach({tabId|targetId}, "1.3") + a
//                      generic sendCommand(target, method, params) that
//                      forwards any CDP domain.method the brain requests.
//   2. Turn leases   — one active "turn" per attached tab; switching turns
//                      detaches the previous one (clean session bookkeeping
//                      via chrome.debugger.onDetach).
//                      (the "brain"). The extension is only the hands; the
//                      brain decides which CDP calls to make. Reconnect with
//                      backoff + host fallback list.
//   4. Hidden-tab render — Emulation.setDeviceMetricsOverride on attached
//                      tabs so lazy content / offscreen tabs still paint.

// MV3 service worker: use importScripts (not ES modules).
// lib/ holds the reusable layers: page actions, CDP transport, capture sessions.
// MV3 service worker: importScripts, not ES modules.
// lib/ holds the reusable layers: page actions, CDP transport, capture
// sessions, attach state, leases.
importScripts(
  "./tablock.js",
  "./ws-auth.js",
  "./lib/page-actions.js",
  "./lib/cdp-transport.js",
  "./lib/capture-store.js",
  "./lib/attach.js",
  "./lib/leases.js",
  "./lib/commands.js",
);

// ---------------- logging ----------------
const logBuf = [];
/** tabId -> last native dialog snapshot (Page.javascriptDialogOpening; diag) */
const lastDialogs = new Map();

function log(level, msg, extra) {
  logBuf.push({ t: Date.now(), level, msg, extra });
  if (logBuf.length > 200) logBuf.shift();
}

// ---------------- CDP transport ----------------
// Implemented in lib/cdp-transport.js: hard sendCommand timeouts, the
// Runtime.evaluate dialog retry, lock budget, and load waiting.
const cdp = createCdpTransport({ chromeApi: chrome, log });
const {
  CDP_VERSION,
  send: cdpSend,
  sendOnce: cdpSendOnce,
  lockMsForCdp,
  waitTabComplete,
} = cdp;

// ---------------- attach state ----------------
// Implemented in lib/attach.js: owns tabs/targetByTab, attach/detach, and
// adopting a debugger session that survived a service-worker restart.
const attach = createAttachManager({
  chromeApi: chrome,
  cdpSend: (...args) => cdpSend(...args),
  log,
  cdpVersion: CDP_VERSION,
});
const tabs = attach.tabs;
const targetByTab = attach.targetByTab;
const getTab = attach.getState;
const doAttach = attach.attach;
const ensureAttached = attach.ensure;
const doDetach = attach.detach;
attach.reconcile();

// Reconcile bookkeeping whenever the browser detaches us (tab closed, the
// "Allow debugging" banner dismissed, or our own detach racing).
chrome.debugger.onDetach.addListener((source) => attach.handleDetach(source));

// ---------------- leases + per-tab lock ----------------
// Implemented in lib/leases.js: client lease sets, hasTabLease, beginCommand,
// and withTabLock (FIFO per tab; attach/detach run under that lock).
const tabLock = new TabLock();
const leases = createLeaseManager({
  tabLock,
  detach: (...args) => doDetach(...args),
  hasCaptureOnTab: (tabId) =>
    [...captureSessions.values()].some((s) => s.tabId === tabId),
  log,
});
const clientLeases = leases.clientLeases;
const acquireLease = leases.acquire;
const hasTabLease = leases.hasTabLease;
const releaseLease = leases.release;
const beginCommand = leases.beginCommand;
const withTabLock = leases.withTabLock;

// ---------------- capture sessions ----------------
// Implemented in lib/capture-store.js: session registry, domain sharing,
// timed stop, and event routing. Dependencies are forwarded lazily because
// the managers above are created later in this file.
const capture = createCaptureStore({
  log,
  cdpSend: (...args) => cdpSend(...args),
  withTabLock: (...args) => withTabLock(...args),
  ensureAttached: (...args) => ensureAttached(...args),
  doDetach: (...args) => doDetach(...args),
  hasTabLease: (...args) => hasTabLease(...args),
  beginCommand: (...args) => beginCommand(...args),
  getAttachedState: (tabId) => tabs.get(tabId),
});
const captureSessions = capture.sessions;
const stopCapture = capture.stop;
// CDP events from attached targets: capture sessions receive them as event.push
// (routed to the owning socket); all other events only maintain local state.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = attach.tabIdForSource(source);
  if (method === "Page.javascriptDialogOpening" && tabId != null) {
    // A native dialog blocks evaluate until timeout; answer it immediately
    // (accept = OK for alert/confirm/prompt, leave for beforeunload) and record
    // it for diag (alert/confirm/prompt all accept = OK, beforeunload = leave).
    lastDialogs.set(tabId, {
      type: params?.type || "",
      message: String(params?.message || "").slice(0, 200),
      ts: Date.now(),
    });
    if (lastDialogs.size > 50)
      lastDialogs.delete(lastDialogs.keys().next().value);
    log("warn", "page dialog opening — auto-accept", {
      tabId,
      type: params?.type,
      message: params?.message,
    });
    const tgt =
      source?.tabId != null
        ? { tabId: source.tabId }
        : source?.targetId
          ? { targetId: source.targetId }
          : null;
    if (tgt) {
      cdpSend(
        tgt,
        "Page.handleJavaScriptDialog",
        { accept: true, promptText: String(params?.defaultPrompt || "") },
        5000,
      ).catch((e) =>
        log("warn", "auto-accept dialog failed", { error: String(e) }),
      );
    }
  }
  // Forward to agents subscribed to this tab's CDP events (capture session).
  capture.pushEvent(tabId, method, params);
});

// ---------------- command executor ----------------
// Implemented in lib/commands.js: the command vocabulary (tabs/open/snapshot/
// click-el/type-el/capture.*/cdp/run/...). Dependencies are forwarded lazily
// because some managers are created later in this file.
const { execAgentCmd } = createCommandExecutor({
  chromeApi: chrome,
  cdpSend,
  cdpSendOnce,
  ensureAttached,
  doAttach,
  doDetach,
  withTabLock,
  acquireLease,
  releaseLease,
  beginCommand,
  hasTabLease,
  capture,
  captureSessions,
  stopCapture,
  snapshotExpr,
  actExpr,
  waitTabComplete,
  lockMsForCdp,
  log,
  lastDialogs,
  logBuf,
  clientLeases,
  agentWsPortsUp: (...args) => agentWsPortsUp(...args),
});

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

// WS channel diagnostics (persisted to chrome.storage.local.wbWsLog, last
// 40). Used to debug "agent runs the server but the extension cannot
// connect": reload the extension, then read the leveldb entry.
function wsLog(line) {
  try {
    chrome.storage.local.get(["wbWsLog"], (res) => {
      const arr = (res?.wbWsLog || []).concat([
        new Date().toISOString().slice(5, 24) + " " + line,
      ]);
      chrome.storage.local.set({ wbWsLog: arr.slice(-40) });
    });
  } catch (_) {}
}

function agentWsPortsUp() {
  return [...agentWs.entries()]
    .filter(([, set]) =>
      [...set].some(
        (ws) => ws.readyState === WebSocket.OPEN && ws.__authenticated,
      ),
    )
    .map(([p]) => p);
}

// Send to one specific socket (result routing: a cmd is answered on the
// socket that issued it; other sockets on the same port are unaffected).
// Best-effort: dropped when the socket is gone.
function wsSendTo(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
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
        extId: chrome.runtime?.id,
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
    if (typeof WebSocket === "undefined") return;
    if (!tokenLoaded) await loadBridgeToken();
    if (!bridgeToken) return;
    for (const port of AGENT_WS_PORTS) {
      if (agentWs.get(port)?.size) continue;
      if (Date.now() < (portCooldown.get(port) || 0)) continue;
      let ws;
      try {
        ws = new WebSocket("ws://127.0.0.1:" + port);
      } catch (_) {
        continue;
      }
      const set = new Set([ws]);
      agentWs.set(port, set);
      ws.__requests = new Map();
      ws.__clients = new Map();
      ws.__authenticated = false;
      ws.__authTimer = setTimeout(() => {
        if (!ws.__authenticated) ws.close();
      }, 5000);
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
      }, 10000);
      ws.onopen = () => {
        ws.__opened = true;
        clearTimeout(ws.__dialTimer);
        if (!wsPingTimer) {
          wsPingTimer = setInterval(() => {
            const ts = Date.now();
            for (const p of agentWsPortsUp()) sendWs(p, { type: "ping", ts });
          }, 20000);
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
        if (!wasOpen) portCooldown.set(port, Date.now() + 15000);
        for (const [clientId, transientClient] of [...ws.__clients])
          disconnectClient(ws, clientId, transientClient).catch((e) =>
            log("warn", "client cleanup failed", { error: String(e) }),
          );
        wsLog("port " + port + " CLOSED");
        scheduleWsRescan();
      };
      ws.onerror = () => {};
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
  }, 5000);
}

// ---------------- side panel <-> background messaging ----------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (typeof msg?.type !== "string" || !msg.type.startsWith("panel."))
    return false;
  (async () => {
    switch (msg?.type) {
      case "panel.status": {
        if (!tokenLoaded) await loadBridgeToken();
        // Reflect the real connection state. WS bridge (primary): a non-empty
        // agentWsPortsUp() means an agent is connected; empty means none is.
        const wsUp = agentWsPortsUp();
        sendResponse({
          ok: true,
          wsAgents: wsUp,
          wsConnected: wsUp.length > 0,
        });
        return;
      }
      case "panel.diag": {
        // Diagnostics: log tail plus current WS connection state.
        chrome.storage.local.get(["wbDiagLog"], (res) => {
          sendResponse({
            ok: true,
            log: res?.wbDiagLog || [],
          });
        });
        return;
      }
      case "panel.cdp": {
        // direct CDP call from the panel UI: { tabId, method, params }
        // Serialized on the tab so it never interleaves with an agent's CDP.
        const tabId = msg.tabId;
        if (typeof tabId !== "number") {
          sendResponse({
            ok: false,
            error: "panel.cdp: tabId must be a number",
          });
          break;
        }
        acquireLease(PANEL_CLIENT, tabId);
        const cdpTimeout = msg.timeoutMs || 15000;
        const result = await withTabLock(
          tabId,
          PANEL_CLIENT,
          async () => {
            const s = await ensureAttached(tabId);
            return cdpSend(
              s.targetId ? { targetId: s.targetId } : { tabId },
              msg.method,
              msg.params || {},
              cdpTimeout,
            );
          },
          lockMsForCdp(cdpTimeout, msg.method),
        );
        sendResponse({ ok: true, result });
        break;
      }
      case "panel.attach":
        if (typeof msg.tabId !== "number") {
          sendResponse({
            ok: false,
            error: "panel.attach: tabId must be a number",
          });
          break;
        }
        acquireLease(PANEL_CLIENT, msg.tabId);
        await withTabLock(msg.tabId, PANEL_CLIENT, () =>
          ensureAttached(msg.tabId),
        );
        sendResponse({ ok: true });
        break;
      case "panel.detach":
        if (typeof msg.tabId !== "number") {
          sendResponse({
            ok: false,
            error: "panel.detach: tabId must be a number",
          });
          break;
        }
        await releaseLease(PANEL_CLIENT, msg.tabId);
        sendResponse({ ok: true });
        break;
      default:
        return; // other runtime listeners own messages such as content.status
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});

// ---------------- content-script handoff ----------------
// The content script (localhost pages) pings the background for extension
// status so the page can tell the agent it is reachable — same handshake
// idea as the original, with our own data-attribute names.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "content.status") {
    sendResponse({
      ok: true,
      status: "connected",
      tabs: [...tabs.entries()].map(([id, s]) => ({
        tabId: id,
        attached: s.attached,
      })),
    });
  }
});

// Keyboard command declared in manifest.json ("open-wb-cdp-panel") — open the
// side panel on demand. Previously declared but with no handler. Guarded for
// test environments where chrome.commands is not mocked.
if (chrome.commands?.onCommand?.addListener) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "open-wb-cdp-panel") {
      chrome.sidePanel.open({}).catch(() => {});
    }
  });
}

// Auto-connect on install/startup. The channel is the agent WS bridge:
// agent apps run a loopback WS server and this worker dials out to it.
// MV3 SWs are lazy: onStartup is what makes the browser boot us at launch,
// and a 30s keepalive alarm re-dials the WS bridge if we ever went idle.
//
// Auto-dial only inside a real browser service worker: chrome.runtime.id is
// always set there and absent in the node test mock, which keeps tests off
// 127.0.0.1.
const IS_BROWSER_SW = !!(
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  chrome.runtime.id
);
if (IS_BROWSER_SW) connectAgentWs();
chrome.runtime.onInstalled?.addListener?.(() => {
  if (IS_BROWSER_SW) connectAgentWs(); // idempotent: no-ops if already connected
  chrome.sidePanel
    ?.setPanelBehavior?.({ openPanelOnActionClick: true })
    ?.catch?.(() => {});
});
chrome.runtime.onStartup?.addListener?.(() => {
  if (IS_BROWSER_SW) connectAgentWs(); // re-dial the agent bridge on every browser launch
});
if (chrome.alarms?.create) {
  chrome.alarms.create("wb-agent-ws-keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm?.addListener?.((alarm) => {
    if (alarm?.name === "wb-agent-ws-keepalive" && IS_BROWSER_SW)
      connectAgentWs();
  });
}

// Test-only handle (module is undefined in a service worker, so this is a
// no-op in the browser).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    connectAgentWs,
    execAgentCmd,
    onWsMessage,
    snapshotExpr,
    actExpr,
    agentWs,
    AGENT_WS_PORTS,
    scheduleWsRescan,
    captureSessions,
    stopCapture,
    disconnectClient,
    loadBridgeToken,
  };
}
