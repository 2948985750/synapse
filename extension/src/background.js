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
  "./lib/ws-bridge.js",
  "./lib/panel-rpc.js",
  "./lib/diag.js",
);

// ---------------- diagnostics ----------------
// Implemented in lib/diag.js: the log ring, the last native-dialog snapshots
// and the auto-accept reaction (a dialog blocks evaluate until timeout).
const diag = createDiag({
  sendCommand: (...args) => cdpSend(...args),
});
const log = diag.log;
const lastDialogs = diag.dialogs;

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
  // Dialog handling first: it may answer the page before capture routing.
  diag.onCdpEvent({ source, tabId, method, params });
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
  clientLeases,
  agentWsPortsUp: (...args) => agentWsPortsUp(...args),
});

// ---------------- agent WS bridge ----------------
// Implemented in lib/ws-bridge.js: port probing, handshake, request routing,
// cooldown and ping. Dependencies are forwarded lazily.
const wsBridge = createWsBridge({
  chromeApi: chrome,
  wsAuth: WSAuth,
  execAgentCmd,
  captureSessions,
  stopCapture,
  clientLeases,
  releaseLease,
  log,
});
const {
  agentWs,
  AGENT_WS_PORTS,
  connectAgentWs,
  onWsMessage,
  disconnectClient,
  loadBridgeToken,
  scheduleWsRescan,
} = wsBridge;
const agentWsPortsUp = wsBridge.portsUp;
// ---------------- side panel <-> background messaging ----------------
// Implemented in lib/panel-rpc.js: the panel leases tabs under a fixed client
// id and serializes its CDP calls on the same per-tab lock as agents.
const panelRpc = createPanelRpc({
  chromeApi: chrome,
  ensureToken: wsBridge.ensureToken,
  portsUp: agentWsPortsUp,
  acquireLease,
  withTabLock,
  ensureAttached,
  cdpSend,
  lockMsForCdp,
  releaseLease,
  panelClient: "panel",
});
chrome.runtime.onMessage.addListener(panelRpc);
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
    diag,
  };
}
