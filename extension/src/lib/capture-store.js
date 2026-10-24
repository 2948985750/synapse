"use strict";
// Capture sessions: let an agent subscribe to CDP domain events on one tab.
//
//   capture.start → enable the domains; matching chrome.debugger.onEvent
//                   events are pushed as {type:"event.push"} to the socket
//                   that started the capture;
//   capture.stop  → stop forwarding and best-effort Domain.disable.
//
// Use case: collect Network.requestWillBeSent / responseReceived /
// loadingFinished during first paint or a re-trigger, then fetch each body
// via Network.getResponseBody — a far better data source than the DOM
// (structured, and it includes the site's own signed API responses).
//
// Design notes (moved verbatim from background.js; behaviour unchanged):
//   - a capture is an independent lease: stopping one must not release the
//     client's explicit/CDP lease and must not disable a domain another
//     capture still uses (see usesDomain);
//   - every capture has a durationMs timer that stops it automatically;
//   - stop runs under the tab lock and never re-attaches a closed/detached target.
//
// Everything chrome/CDP/lock related is injected (see createCaptureStore), so
// the module is testable in node with mocks. Shipped as a classic script:
// exports are attached to both globalThis and module.exports.

function createCaptureStore(deps = {}) {
  const log = deps.log || (() => {});
  const cdpSend = deps.cdpSend;
  const withTabLock = deps.withTabLock;
  const ensureAttached = deps.ensureAttached;
  const doDetach = deps.doDetach;
  const hasTabLease = deps.hasTabLease;
  const getAttachedState = deps.getAttachedState || (() => undefined);
  const now = deps.now || (() => Date.now());
  const STOP_LOCK_MS = deps.stopLockMs || 60000;
  const START_LOCK_MS = deps.startLockMs || 60000;

  const sessions = new Map(); // captureId -> session
  let sequence = 0;

  function usesDomain(tabId, domain, exceptId) {
    return [...sessions.values()].some(
      (s) =>
        s.captureId !== exceptId &&
        s.active &&
        s.tabId === tabId &&
        s.domains.includes(domain),
    );
  }

  async function stop(captureId, ctx) {
    const s = sessions.get(captureId);
    if (!s) return { stopped: false, reason: "no such capture" };
    if (s.stopping) return s.stopping;
    s.active = false;
    if (s.timer) clearTimeout(s.timer);
    s.stopping = withTabLock(
      s.tabId,
      s.clientId,
      async () => {
        try {
          // Cleanup must never re-attach a closed or explicitly detached target.
          const st = getAttachedState(s.tabId);
          if (st?.attached) {
            const target = st.targetId
              ? { targetId: st.targetId }
              : { tabId: s.tabId };
            for (const d of s.domains) {
              if (usesDomain(s.tabId, d, captureId)) continue;
              try {
                await cdpSend(target, d + ".disable", {}, 5000);
              } catch (_) {}
            }
          }
        } finally {
          sessions.delete(captureId);
          if (!hasTabLease(s.tabId)) await doDetach(s.tabId);
        }
        log("info", "capture stopped", { captureId, tabId: s.tabId });
        return { stopped: true, captureId, tabId: s.tabId };
      },
      STOP_LOCK_MS,
      ctx,
    );
    try {
      return await s.stopping;
    } catch (e) {
      s.stopping = null;
      throw e;
    }
  }

  // Returns {started, captureId, tabId, domains, durationMs}; rolls back enabled domains on failure.
  async function start(args, clientId, ctx) {
    const { tabId, domains, durationMs } = args || {};
    if (!Number.isInteger(tabId)) throw new Error("capture.start: need integer tabId");
    const doms = [
      ...new Set(
        Array.isArray(domains) && domains.length ? domains : ["Network"],
      ),
    ];
    if (!doms.every((d) => typeof d === "string" && /^[A-Za-z]+$/.test(d))) {
      throw new Error("capture.start: invalid domain");
    }
    const dur =
      Number.isFinite(durationMs) && durationMs > 0
        ? Math.min(durationMs, 2147483647)
        : 30000;
    if (ctx?.ws == null) throw new Error("capture.start: WS channel only");
    return withTabLock(
      tabId,
      clientId,
      async () => {
        for (const other of sessions.values()) {
          if (
            other.active &&
            other.clientId === clientId &&
            other.tabId === tabId
          ) {
            throw new Error(
              "capture.start: a capture session is already active for this tab+client (stop it first)",
            );
          }
        }
        const enabled = [];
        const s = await ensureAttached(tabId);
        const target = s.targetId ? { targetId: s.targetId } : { tabId };
        try {
          for (const d of doms) {
            if (usesDomain(tabId, d)) continue;
            await cdpSend(target, d + ".enable", {}, 15000);
            enabled.push(d);
          }
          const captureId = "cap-" + now().toString(36) + "-" + ++sequence;
          const sess = {
            captureId,
            clientId,
            tabId,
            domains: doms,
            ws: ctx.ws,
            wsPort: ctx.wsPort,
            active: true,
            timer: null,
          };
          sess.timer = setTimeout(
            () =>
              stop(captureId).catch((e) =>
                log("warn", "capture cleanup failed", { error: String(e) }),
              ),
            dur,
          );
          sessions.set(captureId, sess);
          log("info", "capture started", {
            captureId,
            tabId,
            domains: doms,
            durationMs: dur,
          });
          return {
            started: true,
            captureId,
            tabId,
            domains: doms,
            durationMs: dur,
          };
        } catch (e) {
          for (const d of enabled) {
            if (!usesDomain(tabId, d))
              await cdpSend(target, d + ".disable", {}, 5000).catch(() => {});
          }
          if (!hasTabLease(tabId)) await doDetach(tabId);
          throw e;
        }
      },
      START_LOCK_MS,
      ctx,
    );
  }

  // capture.stop: locate the session by captureId or by tabId+clientId (+ws).
  async function stopByArgs(args, clientId, ctx) {
    const { tabId, captureId } = args || {};
    const sess = captureId
      ? sessions.get(captureId)
      : [...sessions.values()].find(
          (s) =>
            s.active &&
            s.clientId === clientId &&
            s.tabId === tabId &&
            (!ctx?.ws || s.ws === ctx.ws),
        );
    if (!sess) return { stopped: false, reason: "no active capture session" };
    if (sess.clientId !== clientId || (ctx?.ws && sess.ws !== ctx.ws))
      throw new Error("capture.stop: session belongs to another client");
    if (deps.beginCommand) deps.beginCommand(ctx);
    return stop(sess.captureId);
  }

  // CDP event → push to the socket that started the capture (already cleaned up on close).
  function pushEvent(tabId, method, params) {
    if (tabId == null) return 0;
    let pushed = 0;
    for (const s of sessions.values()) {
      if (!s.active || s.tabId !== tabId) continue;
      if (!s.domains.some((d) => method.indexOf(d + ".") === 0)) continue;
      if (s.ws && s.ws.readyState === 1) {
        try {
          s.ws.send(
            JSON.stringify({
              type: "event.push",
              captureId: s.captureId,
              clientId: s.clientId,
              tabId,
              method,
              params,
            }),
          );
          pushed++;
        } catch (_) {}
      }
    }
    return pushed;
  }

  return {
    sessions,
    usesDomain,
    start,
    stop,
    stopByArgs,
    pushEvent,
    size: () => sessions.size,
  };
}

const CaptureStore = { createCaptureStore };
if (typeof globalThis !== "undefined") Object.assign(globalThis, CaptureStore);
if (typeof module !== "undefined" && module.exports) module.exports = CaptureStore;
