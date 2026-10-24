"use strict";
// Attach manager: the single owner of chrome.debugger attach state.
//
// Responsibilities:
//   - tabId -> { attached, targetId, attachError } and the targetId -> tabId
//     reverse index used to route CDP events back to a tab;
//   - attach/detach/ensure-attached, including adopting a debugger session that
//     survived a service-worker restart (otherwise attach throws
//     "Another debugger is already attached");
//   - reconciling bookkeeping when the browser detaches us (tab closed, the
//     "Allow debugging" banner dismissed, our own detach racing).
//
// Contract: attach/detach/ensure must be called with the tab lock held
// (see leases.js / withTabLock) — two clients must never race
// chrome.debugger.attach on the same tab.
//
// Dependencies are injected so the module can be unit-tested in node.
// Loaded as a classic service-worker script (importScripts); exports are also
// attached to globalThis and module.exports.

function createAttachManager(deps = {}) {
  const chromeApi = deps.chromeApi || chrome;
  const cdpSend = deps.cdpSend;
  const log = deps.log || (() => {});
  const cdpVersion = deps.cdpVersion || "1.3";

  /** tabId -> { attached, sessionId, turn, targetId, attachError } */
  const tabs = new Map();
  /** targetId -> tabId (reverse index for debugger event routing) */
  const targetByTab = new Map();

  function getState(tabId) {
    // Reject non-numeric keys up front so a missing tabId (undefined/null from
    // an agent message) can never pollute the state map or reach
    // chrome.debugger with a garbage target.
    if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
      throw new Error("getTab: tabId must be an integer, got " + tabId);
    }
    let s = tabs.get(tabId);
    if (!s) {
      s = { attached: false, sessionId: null, turn: null, targetId: null };
      tabs.set(tabId, s);
    }
    return s;
  }

  // Read-only lookup: never creates an entry (used by modules that only need a
  // snapshot of the current attach state).
  function peek(tabId) {
    return tabs.get(tabId);
  }

  // The SW loses in-memory state on restart, but a physical debugger attach can
  // survive at the browser layer. Adopt those targets at startup so a later
  // ensure() does not call attach() on an already-attached tab.
  function reconcile() {
    try {
      chromeApi.debugger.getTargets((targets) => {
        for (const t of targets || []) {
          if (!t.attached || typeof t.tabId !== "number") continue;
          const s = getState(t.tabId);
          if (!s.attached) {
            s.attached = true;
            s.targetId = t.targetId;
            targetByTab.set(t.targetId, t.tabId);
            log("info", "reconcile: adopted surviving attach", {
              tabId: t.tabId,
              targetId: t.targetId,
            });
          }
        }
      });
    } catch (_) {}
  }

  // Low-level attach. Caller must hold the tab lock.
  //
  // MV3 note: chrome.debugger.attach is promise-based but resolves undefined
  // (only the callback form returns { targetId }), so the targetId must be read
  // back via getTargets().
  async function attach(tabId) {
    const s = getState(tabId);
    if (s.attached) return s;
    try {
      // Adopt an existing physical attach instead of throwing
      // "Another debugger is already attached". If it belongs to this extension
      // sendCommand keeps working; if an external debugger owns it, later CDP
      // calls fail with an explicit "Debugger is not attached".
      const pre = ((await chromeApi.debugger.getTargets()) || []).find(
        (x) => x.tabId === tabId,
      );
      if (pre && pre.attached) {
        s.attached = true;
        s.targetId = pre.targetId;
        targetByTab.set(pre.targetId, tabId);
        log("info", "attach: adopted surviving debugger session", {
          tabId,
          targetId: pre.targetId,
        });
        return s;
      }
      await chromeApi.debugger.attach({ tabId }, cdpVersion);
      const targets = await chromeApi.debugger.getTargets();
      const t = (targets || []).find((x) => x.tabId === tabId);
      if (!t || !t.attached) {
        s.attachError = t
          ? "getTargets: attached=false"
          : "getTargets: tab not found";
        log("warn", "attach failed", { tabId, error: s.attachError });
        return s;
      }
      const targetId = t.targetId;
      s.attached = true;
      s.targetId = targetId;
      targetByTab.set(targetId, tabId);
      // Keep hidden/background tabs rendering so lazy content and screenshots
      // behave like the visible tab (override first, cleared when detached).
      await cdpSend({ targetId }, "Emulation.setDeviceMetricsOverride", {
        mobile: false,
        width: 1440,
        height: 900,
        deviceScaleFactor: 0,
        screenFraction: 1,
      }).catch(() => {});
      await cdpSend({ targetId }, "Page.enable").catch(() => {});
      await cdpSend({ targetId }, "Runtime.enable").catch(() => {});
      log("info", "attach ok", { tabId, targetId });
    } catch (e) {
      // Keep the real reason on the state: ensure() surfaces it in the error
      // text instead of a bare "attach did not stick" (common causes: DevTools
      // or another debugger extension is attached; browser-internal page).
      s.attachError = String((e && e.message) || e);
      log("warn", "attach failed", { tabId, error: s.attachError });
    }
    return s;
  }

  // Idempotent attach. Caller must hold the tab lock. Propagates failure rather
  // than handing back an un-attached state, so callers surface a clear error
  // instead of firing a CDP command that fails with an opaque "Not attached".
  async function ensure(tabId) {
    const s = getState(tabId);
    if (!s.attached) await attach(tabId);
    const st = getState(tabId);
    if (!st.attached) {
      const why = st.attachError ? " (" + st.attachError + ")" : "";
      throw new Error(
        "ensureAttached: attach did not stick for tab " +
          tabId +
          why +
          " — if it says Another debugger is already attached: close that tab's DevTools or the other debugger extension and retry",
      );
    }
    return st;
  }

  // Low-level detach. Caller must hold the tab lock.
  async function detach(tabId) {
    const s = getState(tabId);
    if (!s.attached) return;
    if (s.targetId) {
      await cdpSend(
        { targetId: s.targetId },
        "Emulation.clearDeviceMetricsOverride",
      ).catch(() => {});
    }
    try {
      await chromeApi.debugger.detach({ tabId });
    } catch (_) {}
    const deadTarget = s.targetId;
    s.attached = false;
    s.targetId = null;
    targetByTab.delete(deadTarget);
    log("info", "detached", { tabId });
  }

  // Clear bookkeeping without touching the browser (the browser already
  // detached us). Reconciles both the tab entry and the reverse index.
  function clear(tabId) {
    const s = tabs.get(tabId);
    if (s) {
      s.attached = false;
      if (s.targetId) {
        targetByTab.delete(s.targetId);
        s.targetId = null;
      }
    }
  }

  // Handler for chrome.debugger.onDetach: whatever form the source arrives in
  // (tabId, targetId, or both), both indexes get reconciled.
  function handleDetach(source) {
    let tid = null;
    if (typeof source.targetId === "string") tid = source.targetId;
    if (typeof source.tabId === "number") {
      clear(source.tabId);
    }
    // targetId-only: resolve its tab. tabId+target: clear that target too
    // (covers sub-target / frame detaches).
    if (tid != null) {
      const ownerTab = targetByTab.get(tid);
      if (ownerTab != null) clear(ownerTab);
      else targetByTab.delete(tid);
    }
  }

  // Resolve the tab that produced a chrome.debugger event.
  function tabIdForSource(source) {
    return source?.tabId ?? targetByTab.get(source?.targetId);
  }

  return {
    tabs,
    targetByTab,
    getState,
    peek,
    reconcile,
    attach,
    ensure,
    detach,
    clear,
    handleDetach,
    tabIdForSource,
  };
}

const AttachManager = { createAttachManager };
if (typeof globalThis !== "undefined") Object.assign(globalThis, AttachManager);
if (typeof module !== "undefined" && module.exports)
  module.exports = AttachManager;
