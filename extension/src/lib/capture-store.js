"use strict";
// Capture 会话：让 agent 订阅某个 tab 上若干 CDP 域的事件。
//
//   capture.start → 对目标 Domain.enable，chrome.debugger.onEvent 匹配到的事件
//                   以 {type:"event.push"} 定向推给【发起捕获的那条 socket】；
//   capture.stop  → 停止转发 + 尽力 Domain.disable。
//
// 用途：agent 在首屏加载/重新触发期间收集 Network.requestWillBeSent /
// responseReceived / loadingFinished，再逐条 Network.getResponseBody 拿响应体
// —— 比 DOM 高效得多的数据源（结构化、含站点自签名 API 响应）。
//
// 设计要点（从 background.js 原样搬出，行为未改）：
//   - capture 是独立租约：停一个 capture 不能释放 client 的显式/CDP 租约，
//     也不能 disable 别的 capture 还在用的 domain（usesDomain 判断）。
//   - 每个 capture 有 durationMs 定时器，到点自动 stop。
//   - stop 在 tab 锁内执行，且"不重新 attach 已关闭/已 detach 的 target"。
//
// 依赖注入：所有 chrome/CDP/锁相关能力由外部给（见 createCaptureStore 的参数），
// 这样本模块在 node 里可以直接用 mock 测。
// 交付形态：经典脚本（importScripts 加载），同时挂 globalThis 与 module.exports。

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
          // 清理绝不能重新 attach 一个已关闭、或已被显式 detach 的 target。
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

  // 返回 { started, captureId, tabId, domains, durationMs }；失败时回滚已 enable 的域。
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

  // capture.stop：按 captureId 或 tabId+clientId(+ws) 定位会话。
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

  // CDP 事件 → 定向推给发起捕获的那条 socket（socket 断开时会话已被清理）。
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
