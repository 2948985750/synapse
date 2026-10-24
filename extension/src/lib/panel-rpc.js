"use strict";
// Side-panel RPC: the panel is a client like any other, but under a fixed
// client id so its CDP calls can never collide with an agent's lease.
//
// Every branch answers through sendResponse; unknown messages are left to the
// other chrome.runtime listeners (content-script handoff), which is why the
// handler returns false for them.

function createPanelRpc(deps = {}) {
  const chrome = deps.chromeApi || globalThis.chrome;
  const ensureToken = deps.ensureToken;
  const portsUp = deps.portsUp;
  const acquireLease = deps.acquireLease;
  const withTabLock = deps.withTabLock;
  const ensureAttached = deps.ensureAttached;
  const cdpSend = deps.cdpSend;
  const lockMsForCdp = deps.lockMsForCdp;
  const releaseLease = deps.releaseLease;
  const PANEL_CLIENT = deps.panelClient || "panel";


  return function panelHandler(msg, _sender, sendResponse) {
    if (typeof msg?.type !== "string" || !msg.type.startsWith("panel."))
      return false;
    (async () => {
      switch (msg?.type) {
        case "panel.status": {
          await ensureToken();
          // Reflect the real connection state. WS bridge (primary): a non-empty
          // portsUp() means an agent is connected; empty means none is.
          const wsUp = portsUp();
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
  };


}

const PanelRpc = { createPanelRpc };
if (typeof globalThis !== "undefined") Object.assign(globalThis, PanelRpc);
if (typeof module !== "undefined" && module.exports) module.exports = PanelRpc;
