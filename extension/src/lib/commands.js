"use strict";
// Agent command executor: one agent request in, one result out.
//
// This is the only place that knows the command vocabulary (tabs / open /
// snapshot / click-el / type-el / capture.* / cdp / run / ...). It contains no
// protocol code: the WS bridge parses messages and calls execAgentCmd, then
// routes the resolved value (or thrown error) back to the caller.
//
// Dependencies are injected so the executor is testable without a browser.
// Loaded as a classic service-worker script; exports also land on globalThis
// and module.exports.

function createCommandExecutor(deps = {}) {
  const chrome = deps.chromeApi;
  const cdpSend = deps.cdpSend;
  const cdpSendOnce = deps.cdpSendOnce;
  const ensureAttached = deps.ensureAttached;
  const doAttach = deps.doAttach;
  const doDetach = deps.doDetach;
  const withTabLock = deps.withTabLock;
  const acquireLease = deps.acquireLease;
  const releaseLease = deps.releaseLease;
  const beginCommand = deps.beginCommand;
  const hasTabLease = deps.hasTabLease;
  const capture = deps.capture;
  const captureSessions = deps.captureSessions;
  const stopCapture = deps.stopCapture;
  const snapshotExpr = deps.snapshotExpr;
  const actExpr = deps.actExpr;
  const waitTabComplete = deps.waitTabComplete;
  const lockMsForCdp = deps.lockMsForCdp;
  const log = deps.log;
  const lastDialogs = deps.lastDialogs;
  const logBuf = deps.logBuf;
  const clientLeases = deps.clientLeases;
  const agentWsPortsUp = deps.agentWsPortsUp;

  async function execAgentCmd(cmd, args, clientId, ctx) {
    switch (cmd) {
      case "tabs": {
        const all = await chrome.tabs.query({});
        return all.map((t) => ({
          tabId: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
        }));
      }
      case "capture.start":
        // Implemented in lib/capture-store.js: domain sharing, timed stop, rollback.
        return capture.start(args, clientId, ctx);
      case "capture.stop":
        return capture.stopByArgs(args, clientId, ctx);
      // Indexed action space: snapshot enumerates interactive controls; click-el/
      // type-el re-resolve the snapshot entry before acting (stale → refuse).
      case "snapshot": {
        const { tabId, max } = args || {};
        if (typeof tabId !== "number")
          throw new Error("snapshot: tabId must be a number");
        return await withTabLock(
          tabId,
          clientId,
          async () => {
            acquireLease(clientId, tabId);
            const s = await ensureAttached(tabId);
            const target = s.targetId ? { targetId: s.targetId } : { tabId };
            const r = await cdpSend(
              target,
              "Runtime.evaluate",
              { expression: snapshotExpr(max), returnByValue: true },
              15000,
            );
            const v = r && r.result ? r.result.value : null;
            return v != null
              ? JSON.parse(v)
              : { error: "snapshot evaluate returned nothing" };
          },
          45000,
          ctx,
        ); // the lock must outlive the evaluate dialog retry (2×15s + 6s)
      }
      case "click-el": {
        const { tabId, el } = args || {};
        if (typeof tabId !== "number" || !el || typeof el.i !== "number")
          throw new Error("click-el: need tabId + el{i,label} (from snapshot)");
        return await withTabLock(
          tabId,
          clientId,
          async () => {
            acquireLease(clientId, tabId);
            const s = await ensureAttached(tabId);
            const target = s.targetId ? { targetId: s.targetId } : { tabId };
            const r = await cdpSend(
              target,
              "Runtime.evaluate",
              { expression: actExpr(el, "click", ""), returnByValue: true },
              15000,
            );
            const v = r && r.result ? r.result.value : null;
            return v != null
              ? JSON.parse(v)
              : { found: false, reason: "evaluate returned nothing" };
          },
          45000,
          ctx,
        ); // the lock must outlive the evaluate dialog retry (2×15s + 6s)
      }
      case "type-el": {
        const { tabId, el, text, clear } = args || {};
        if (
          typeof tabId !== "number" ||
          !el ||
          typeof el.i !== "number" ||
          typeof text !== "string"
        )
          throw new Error("type-el: need tabId + el + text");
        return await withTabLock(
          tabId,
          clientId,
          async () => {
            acquireLease(clientId, tabId);
            const s = await ensureAttached(tabId);
            const target = s.targetId ? { targetId: s.targetId } : { tabId };
            const payload = clear ? "__CLEAR__" + text : text;
            const r = await cdpSend(
              target,
              "Runtime.evaluate",
              { expression: actExpr(el, "type", payload), returnByValue: true },
              15000,
            );
            const v = r && r.result ? r.result.value : null;
            return v != null
              ? JSON.parse(v)
              : { found: false, reason: "evaluate returned nothing" };
          },
          45000,
          ctx,
        ); // the lock must outlive the evaluate dialog retry (2×15s + 6s)
      }
      case "cdp": {
        const { tabId, method, params } = args || {};
        if (typeof tabId !== "number")
          throw new Error("cdp: tabId must be a number");
        const cdpTimeout = args.timeoutMs || 20000;
        return await withTabLock(
          tabId,
          clientId,
          async () => {
            acquireLease(clientId, tabId);
            const s = await ensureAttached(tabId);
            const target = s.targetId ? { targetId: s.targetId } : { tabId };
            return cdpSend(target, method, params, cdpTimeout);
          },
          lockMsForCdp(cdpTimeout, method),
          ctx,
        );
      }
      case "setfile": {
        const { tabId, selector, files } = args || {};
        if (typeof tabId !== "number")
          throw new Error("setfile: tabId must be a number");
        if (typeof selector !== "string" || !Array.isArray(files))
          throw new Error("setfile: need selector + files[]");
        return await withTabLock(
          tabId,
          clientId,
          async () => {
            acquireLease(clientId, tabId);
            const s = await ensureAttached(tabId);
            const target = s.targetId ? { targetId: s.targetId } : { tabId };
            const doc = await cdpSend(target, "DOM.getDocument", { depth: 1 });
            const rootId = doc && doc.root && doc.root.nodeId;
            const q = await cdpSend(target, "DOM.querySelectorAll", {
              nodeId: rootId,
              selector,
            });
            const ids = (q && q.nodeIds) || [];
            if (!ids.length)
              throw new Error("setfile: no element matches " + selector);
            await cdpSend(target, "DOM.setFileInputFiles", {
              files,
              nodeId: ids[0],
            });
            return { ok: true, matched: ids.length };
          },
          30000,
          ctx,
        );
      }
      case "navigate": {
        // Navigate via chrome.tabs.update (no attach needed): chrome.debugger cannot
        // attach to internal pages such as edge://, so CDP Page.navigate always fails
        // there; the tabs API works for every tab.
        // Wait for load by default (T-30: without it a slow site returns an empty
        // DOM on an immediate run); waitMs<=0 skips the wait.
        const { tabId, url } = args || {};
        if (typeof tabId !== "number" || typeof url !== "string")
          throw new Error("navigate: need numeric tabId + string url");
        beginCommand(ctx);
        await chrome.tabs.update(tabId, { url });
        const waitMs = args.waitMs == null ? 15000 : Number(args.waitMs);
        const load = await waitTabComplete(tabId, waitMs);
        return { navigated: true, tabId, url, ...load };
      }
      case "open": {
        const { url } = args || {};
        if (typeof url !== "string") throw new Error("open: need string url");
        beginCommand(ctx);
        const t = await chrome.tabs.create({ url, active: true });
        // Wait for load by default (T-30 fix); waitMs<=0 skips the wait.
        const waitMs = args.waitMs == null ? 15000 : Number(args.waitMs);
        const load = await waitTabComplete(t.id, waitMs);
        return { opened: true, tabId: t.id, url, ...load };
      }
      case "open-frame": {
        // Fallback when cross-origin iframe content is unreachable (OOPIF limit,
        // T-30): locate the matching child frame via Page.getFrameTree and open it as
        // a top-level tab (same-origin session carried over).
        const { tabId, urlPattern } = args || {};
        if (typeof tabId !== "number")
          throw new Error("open-frame: tabId must be a number");
        if (typeof urlPattern !== "string" || !urlPattern)
          throw new Error("open-frame: need urlPattern regex string");
        const re = new RegExp(urlPattern, "i");
        return await withTabLock(
          tabId,
          clientId,
          async () => {
            acquireLease(clientId, tabId);
            const s = await ensureAttached(tabId);
            const target = s.targetId ? { targetId: s.targetId } : { tabId };
            const ft = await cdpSend(target, "Page.getFrameTree", {}, 15000);
            const frames = [];
            (function walk(node) {
              if (!node) return;
              if (node.frame) frames.push(node.frame);
              for (const c of node.childFrames || []) walk(c);
            })(ft && ft.frameTree);
            const hit = frames.find((f) => re.test(f.url || ""));
            if (!hit) {
              return {
                opened: false,
                reason: "no frame matches " + urlPattern,
                frames: frames.map((f) => f.url),
              };
            }
            const t = await chrome.tabs.create({ url: hit.url, active: true });
            const load = await waitTabComplete(t.id, 15000);
            return {
              opened: true,
              tabId: t.id,
              frameUrl: hit.url,
              frameOrigin: hit.securityOrigin || "",
              ...load,
            };
          },
          45000,
          ctx,
        );
      }
      case "close": {
        if (typeof args?.tabId !== "number")
          throw new Error("close: need numeric tabId");
        beginCommand(ctx);
        await chrome.tabs.remove(args.tabId);
        return { closed: true, tabId: args.tabId };
      }
      case "attach": {
        if (typeof args?.tabId !== "number")
          throw new Error("attach: tabId must be a number");
        await withTabLock(
          args.tabId,
          clientId,
          () => {
            acquireLease(clientId, args.tabId);
            return ensureAttached(args.tabId);
          },
          60000,
          ctx,
        );
        return { attached: true, tabId: args.tabId };
      }
      case "detach": {
        if (typeof args?.tabId !== "number")
          throw new Error("detach: need numeric tabId");
        if (args.force) {
          // Force a physical detach (drops this extension's leftover debugger session)
          await withTabLock(
            args.tabId,
            clientId,
            () => doDetach(args.tabId),
            60000,
            ctx,
          );
          return { detached: true, forced: true, tabId: args.tabId };
        }
        beginCommand(ctx);
        await releaseLease(clientId, args.tabId);
        return { detached: true, tabId: args.tabId };
      }
      case "diag": {
        const [diagRes, wsRes] = await Promise.all([
          new Promise((resolve) => {
            chrome.storage.local.get(["wbDiagLog"], (r) =>
              resolve(r?.wbDiagLog || []),
            );
          }),
          new Promise((resolve) => {
            chrome.storage.local.get(["wbWsLog"], (r) =>
              resolve(r?.wbWsLog || []),
            );
          }),
        ]);
        return {
          wsAgents: agentWsPortsUp(),
          clients: [...clientLeases.entries()].map(([cid, set]) => ({
            clientId: cid,
            tabs: [...set],
          })),
          log: diagRes,
          wsLog: wsRes,
          dialogs: [...lastDialogs.entries()].map(([tid, d]) => ({
            tabId: tid,
            ...d,
          })),
        };
      }
      default:
        throw new Error("unknown agent cmd: " + cmd);
    }
  }


  return { execAgentCmd };
}

const CommandExecutor = { createCommandExecutor };
if (typeof globalThis !== "undefined") Object.assign(globalThis, CommandExecutor);
if (typeof module !== "undefined" && module.exports) module.exports = CommandExecutor;
