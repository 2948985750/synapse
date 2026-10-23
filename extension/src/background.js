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
//   3. Native brain  — chrome.runtime.connectNative() to a local host
//                      (the "brain"). The extension is only the hands; the
//                      brain decides which CDP calls to make. Reconnect with
//                      backoff + host fallback list.
//   4. Hidden-tab render — Emulation.setDeviceMetricsOverride on attached
//                      tabs so lazy content / offscreen tabs still paint.

// MV3 service worker: use importScripts (not ES modules) for tablock.
importScripts("./tablock.js", "./ws-auth.js");

const CDP_VERSION = "1.3";

// cdpSend forwards ANY CDP domain.method the brain requests, straight to the
// attached tab. No domain allow-list, no method block-list — the extension is
// a full CDP passthrough. Only a structural guard remains: the method must be
// a non-empty string so a garbage payload can't reach chrome.debugger with an
// undefined shape.
function cdpMethodAllowed(method) {
  if (typeof method !== "string" || !method) {
    throw new Error("cdpSend: method must be a non-empty string like 'Domain.method'");
  }
  return true;
}

// Host fallback order: try each native host until one accepts.
const NATIVE_HOSTS = [
  "com.workbuddy.cdpbrain", // production name (register with register-dev.ps1)
  "com.workbuddy.cdpbrain.dev",
];

// ---------------- state ----------------
/** tabId -> { attached, sessionId, turn, targetId } */
const tabs = new Map();
/** targetId -> tabId (reverse index for debugger event routing) */
const targetByTab = new Map();
// ---------------- capture sessions（CDP 事件 → agent 转发） ----------------
// 一个 capture session 让 agent（某条 WS 连接）订阅某 tab 上若干 CDP 域的事件：
//   capture.start  → 对目标 Network.enable 等，chrome.debugger.onEvent 匹配到的
//                    事件以 {type:"event.push"} 定向推给【发起捕获的那条 socket】；
//   capture.stop   → 停止转发 + 尽力 Domain.disable。
// 用途：agent 在页面首屏加载/重新触发期间收集 Network.requestWillBeSent /
// responseReceived / loadingFinished，再逐条 Network.getResponseBody 拿响应体
// —— 这是比 DOM 高效得多的数据源（结构化、含站点自签名 API 响应）。
// Capture entries are independent tab leases; stopping one must not release a
// client's explicit/CDP lease or disable a domain used by another capture.
const captureSessions = new Map();
let captureSequence = 0;
function captureUsesDomain(tabId, domain, exceptId) {
  return [...captureSessions.values()].some((s) =>
    s.captureId !== exceptId && s.active && s.tabId === tabId && s.domains.includes(domain));
}

async function stopCapture(captureId, ctx) {
  const s = captureSessions.get(captureId);
  if (!s) return { stopped: false, reason: "no such capture" };
  if (s.stopping) return s.stopping;
  s.active = false;
  if (s.timer) clearTimeout(s.timer);
  s.stopping = withTabLock(s.tabId, s.clientId, async () => {
    try {
      // Cleanup must never reattach a closed or explicitly detached target.
      const st = tabs.get(s.tabId);
      if (st?.attached) {
        const target = st.targetId ? { targetId: st.targetId } : { tabId: s.tabId };
        for (const d of s.domains) {
          if (captureUsesDomain(s.tabId, d, captureId)) continue;
          try { await cdpSend(target, d + ".disable", {}, 5000); } catch (_) {}
        }
      }
    } finally {
      captureSessions.delete(captureId);
      if (!hasTabLease(s.tabId)) await doDetach(s.tabId);
    }
    log("info", "capture stopped", { captureId, tabId: s.tabId });
    return { stopped: true, captureId, tabId: s.tabId };
  }, 60000, ctx);
  try {
    return await s.stopping;
  } catch (e) {
    s.stopping = null;
    throw e;
  }
}
// Concurrency model (shared gate, exclusive tab, serialized commands):
//  - Multiple agent conversations may use the extension at once.
//  - CDP ops on one tab are serialized FIFO by tabLock (tablock.js).
//  - clientId identifies a lease owner; leases track which tabs a client
//    attached so we can detach them when that client finishes.
const tabLock = new TabLock();
const clientLeases = new Map(); // clientId -> Set<tabId>
const logBuf = [];
/** tabId -> 最近一次原生弹窗快照（Page.javascriptDialogOpening；diag 可查） */
const lastDialogs = new Map();

// SW 重启后内存状态（tabs / targetByTab）丢失，但浏览器层的 debugger 物理
// 附加可能还在（旧实例 attach 的会话）。启动时对齐一次：把仍 attached 的
// target 收养进状态，避免 ensureAttached 再 attach 撞 "Another debugger is
// already attached"（旧代码里表现为 "attach did not stick"）。
function reconcileDebugTargets() {
  try {
    chrome.debugger.getTargets((targets) => {
      for (const t of targets || []) {
        if (!t.attached || typeof t.tabId !== "number") continue;
        const s = getTab(t.tabId);
        if (!s.attached) {
          s.attached = true;
          s.targetId = t.targetId;
          targetByTab.set(t.targetId, t.tabId);
          log("info", "reconcile: adopted surviving attach", { tabId: t.tabId, targetId: t.targetId });
        }
      }
    });
  } catch (_) {}
}
reconcileDebugTargets();

function log(level, msg, extra) {
  logBuf.push({ t: Date.now(), level, msg, extra });
  if (logBuf.length > 200) logBuf.shift();
}

function getTab(tabId) {
  // Reject non-numeric keys up front so a missing tabId (undefined/null from
  // a brain/agent message) can never pollute the state Map or reach
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

// ---------------- CDP bridge ----------------
async function cdpSendOnce(target, method, params, timeoutMs) {
  cdpMethodAllowed(method);
  const t = typeof target?.targetId === "string"
    ? { targetId: target.targetId }
    : target; // { tabId } form
  // Race the CDP call against a real timer. A hanging sendCommand must not
  // wedge the tab lock forever (the caller holds it for the whole cdpSend).
  let timerId;
  const timeout = new Promise((_, rej) => {
    timerId = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), timeoutMs);
  });
  try {
    return await Promise.race([chrome.debugger.sendCommand(t, method, params || {}), timeout]);
  } finally {
    clearTimeout(timerId);
  }
}

// 原生弹窗（alert/confirm/prompt）会卡住该 tab 的一切 evaluate（T-30）。实测
// 弹窗出现后 ~5s 浏览器侧自愈，所以 evaluate 超时按"疑似弹窗"处理：等 6s 重试
// 一次。调用方的锁超时须覆盖 最坏 2×timeoutMs+6s（用 lockMsForCdp 算）。
const DIALOG_RETRY_WAIT_MS = 6000;
async function cdpSend(target, method, params, timeoutMs = 15000) {
  try {
    return await cdpSendOnce(target, method, params, timeoutMs);
  } catch (e) {
    if (method === "Runtime.evaluate" && /CDP timeout/.test(String((e && e.message) || e))) {
      log("warn", "Runtime.evaluate timeout — suspected modal dialog, retrying once", {
        waitMs: DIALOG_RETRY_WAIT_MS,
      });
      await new Promise((r) => setTimeout(r, DIALOG_RETRY_WAIT_MS));
      try {
        return await cdpSendOnce(target, method, params, timeoutMs);
      } catch (e2) {
        throw new Error(
          "Runtime.evaluate 超时两次（疑似页面原生弹窗卡住该标签）——close 该 tab 或人工处理弹窗后重试：" +
            String((e2 && e2.message) || e2)
        );
      }
    }
    throw e;
  }
}

// cdp 命令的锁超时：锁必须活得比 CDP 调用久；Runtime.evaluate 有弹窗重试，
// 最坏 2×timeoutMs+6s，其余 1×timeoutMs+5s。
function lockMsForCdp(cdpTimeoutMs, method) {
  return method === "Runtime.evaluate"
    ? 2 * cdpTimeoutMs + DIALOG_RETRY_WAIT_MS + 5000
    : cdpTimeoutMs + 5000;
}

// 轮询标签加载完成（T-30：open/navigate 不等 load，慢站立刻 run 拿到空 DOM）。
// status=complete 即返回 loaded:true；waitMs 到点放行（loaded:false）；标签被
// 关也放行（gone:true）。waitMs<=0 跳过轮询。
async function waitTabComplete(tabId, waitMs) {
  if (!Number.isFinite(waitMs) || waitMs <= 0) return { loaded: false, waitMs: 0 };
  const t0 = Date.now();
  for (;;) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return { loaded: true, waitMs: Date.now() - t0 };
    } catch (_) {
      return { loaded: false, waitMs: Date.now() - t0, gone: true };
    }
    if (Date.now() - t0 >= waitMs) return { loaded: false, waitMs };
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Low-level attach. MUST be called with the tab lock held (see withTabLock),
// otherwise two conversations can race `chrome.debugger.attach` on one tab.
//
// 注意：MV3 的 chrome.debugger.attach 是 Promise 化 API，但它 resolve 的是
// undefined（回调形态才带 {targetId}）。所以不能解构返回值，attach 后要用
// getTargets 查 targetId 并确认 attached 状态。
async function doAttach(tabId) {
  const s = getTab(tabId);
  if (s.attached) return s;
  try {
    // 先查现状：若该标签已有物理 debugger 附加（常见：上一代 SW 会话的
    // 附加在 SW 重启后仍挂在浏览器层），直接收养而不是报错
    // "Another debugger is already attached"。收养后 sendCommand 若可用
    // （本扩展自己的会话）即可继续工作；若是外部调试器占用，后续 CDP
    // 调用会给出明确的 "Debugger is not attached" 错误。
    const pre = ((await chrome.debugger.getTargets()) || []).find((x) => x.tabId === tabId);
    if (pre && pre.attached) {
      s.attached = true;
      s.targetId = pre.targetId;
      targetByTab.set(pre.targetId, tabId);
      log("info", "attach: adopted surviving debugger session", { tabId, targetId: pre.targetId });
      return s;
    }
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    const targets = await chrome.debugger.getTargets();
    const t = (targets || []).find((x) => x.tabId === tabId);
    if (!t || !t.attached) {
      s.attachError = t ? "getTargets: attached=false" : "getTargets: tab not found";
      log("warn", "attach failed", { tabId, error: s.attachError });
      return s;
    }
    const targetId = t.targetId;
    s.attached = true;
    s.targetId = targetId;
    targetByTab.set(targetId, tabId);
    // Keep hidden/background tabs rendering so lazy content & screenshots
    // behave like the visible tab (device-metrics override, then cleared
    // when detached).
    await cdpSend({ targetId }, "Emulation.setDeviceMetricsOverride", {
      mobile: false,
      width: 1440,
      height: 900,
      deviceScaleFactor: 0,
      screenFraction: 1,
    }).catch(() => {});
    await cdpSend({ targetId }, "Page.enable").catch(() => {});
    await cdpSend({ targetId }, "Runtime.enable").catch(() => {});
    log("info", `attach ok`, { tabId, targetId });
  } catch (e) {
    // 把真实失败原因挂到状态上：ensureAttached 会把它带进 error 文本，
    // 而不是只留一个 "attach did not stick"（常见原因：别的调试器已附加
    // 到该标签 —— DevTools / 其它扩展；或该标签是浏览器内部页）。
    s.attachError = String((e && e.message) || e);
    log("warn", "attach failed", { tabId, error: s.attachError });
  }
  return s;
}

// Idempotent: attach only if needed. MUST be called with the tab lock held.
// Propagates attach failure instead of handing back an un-attached state —
// callers (act.cdp / agent.cmd cdp / panel.cdp) then surface a clear error
// rather than firing a CDP command that fails with an opaque "Not attached".
async function ensureAttached(tabId) {
  const s = getTab(tabId);
  if (!s.attached) await doAttach(tabId);
  const st = getTab(tabId);
  if (!st.attached) {
    const why = st.attachError ? " (" + st.attachError + ")" : "";
    throw new Error("ensureAttached: attach did not stick for tab " + tabId + why +
      " — 若提示 Another debugger is already attached：先关掉该标签的 DevTools / 其它占调试器的扩展，再重试");
  }
  return st;
}

// Low-level detach. MUST be called with the tab lock held.
async function doDetach(tabId) {
  const s = getTab(tabId);
  if (!s.attached) return;
  if (s.targetId) {
    await cdpSend({ targetId: s.targetId }, "Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {}
  const deadTarget = s.targetId;
  s.attached = false;
  s.targetId = null;
  targetByTab.delete(deadTarget);
  log("info", "detached", { tabId });
}

// Clean up bookkeeping when the browser itself detaches us (tab closed,
// debugger banner "Allow debugging", or our own detach racing). Unified via
// clearTab so we never leave a half-cleared state: whichever form the detach
// source arrives in (tabId, targetId, or both), both the tab entry AND the
// targetByTab reverse index get reconciled.
chrome.debugger.onDetach.addListener((source) => {
  let tid = null;
  if (typeof source.targetId === "string") tid = source.targetId;
  if (typeof source.tabId === "number") {
    clearTab(source.tabId);
  }
  // If we got only a targetId, resolve its tab; if we got a tabId but its
  // target, clear that target too (covers sub-target / frame detaches).
  if (tid != null) {
    const ownerTab = targetByTab.get(tid);
    if (ownerTab != null) clearTab(ownerTab);
    else targetByTab.delete(tid);
  }
});

function clearTab(tabId) {
  const s = tabs.get(tabId);
  if (s) {
    s.attached = false;
    if (s.targetId) {
      targetByTab.delete(s.targetId);
      s.targetId = null;
    }
  }
}

// CDP events from attached targets get forwarded to the brain (best effort;
// no-op if the brain port is down). All event domains are forwarded — the
// extension is a full passthrough, and the brain decides what to use.
chrome.debugger.onEvent.addListener((source, method, params) => {
  brainSend({ type: "cdp.event", source, method, params });
  const tabId = source?.tabId ?? targetByTab.get(source?.targetId);
  if (method === "Page.javascriptDialogOpening" && tabId != null) {
    // 原生弹窗会卡 evaluate 直到超时；立即应答（alert/confirm/prompt 一律
    // accept = OK，beforeunload accept = 离开，即导航意图）并记录供 diag。
    lastDialogs.set(tabId, {
      type: params?.type || "",
      message: String(params?.message || "").slice(0, 200),
      ts: Date.now(),
    });
    if (lastDialogs.size > 50) lastDialogs.delete(lastDialogs.keys().next().value);
    log("warn", "page dialog opening — auto-accept", { tabId, type: params?.type, message: params?.message });
    const tgt = source?.tabId != null ? { tabId: source.tabId } : source?.targetId ? { targetId: source.targetId } : null;
    if (tgt) {
      cdpSend(tgt, "Page.handleJavaScriptDialog", { accept: true, promptText: String(params?.defaultPrompt || "") }, 5000)
        .catch((e) => log("warn", "auto-accept dialog failed", { error: String(e) }));
    }
  }
  // 转发给订阅了该 tab CDP 事件的 agent（capture session）。
  if (tabId != null) {
    for (const s of captureSessions.values()) {
      if (!s.active || s.tabId !== tabId) continue;
      if (!s.domains.some((d) => method.indexOf(d + ".") === 0)) continue;
      // 定向推给发起捕获的那条 socket（该 socket 断开时 session 已被清理，不会漏推）
      if (s.ws && s.ws.readyState === 1) {
        try { s.ws.send(JSON.stringify({ type: "event.push", captureId: s.captureId, clientId: s.clientId, tabId, method, params })); } catch (_) {}
      }
    }
  }
});

// ---------------- turn leases (per-client, concurrency-safe) ----------------
// No global "one active turn" anymore: each client (agent conversation) holds
// its own lease. CDP *operations* on a tab are serialized by tabLock so two
// conversations never interleave on one tab, and attach/detach themselves are
// performed under the lock (chrome.debugger.attach on an already-attached tab
// throws, so it must be exclusive).
function leaseFor(clientId) {
  let l = clientLeases.get(clientId);
  if (!l) {
    l = new Set();
    clientLeases.set(clientId, l);
  }
  return l;
}

// Bookkeeping only: record that this client is using this tab. The actual
// attach happens under the tab lock at the op call site (ensureAttached).
function acquireLease(clientId, tabId) {
  leaseFor(clientId).add(tabId);
  log("info", "lease acquired", { clientId, tabId });
}

// Release this client's hold on a tab. The physical detach fires only when NO
// other client still leases the tab, and it is done under the tab lock.
function hasTabLease(tabId) {
  return [...clientLeases.values()].some((l) => l.has(tabId)) ||
    [...captureSessions.values()].some((s) => s.tabId === tabId);
}

async function releaseLease(clientId, tabId) {
  return withTabLock(tabId, clientId, async () => {
    const l = clientLeases.get(clientId);
    if (!l || !l.has(tabId)) return;
    l.delete(tabId);
    if (!l.size) clientLeases.delete(clientId);
    const stillLeased = hasTabLease(tabId);
    if (!stillLeased) await doDetach(tabId);
    log("info", "lease released", { clientId, tabId, detached: !stillLeased });
  });
}

/**
 * Run a CDP command on a tab with exclusive, FIFO-serialized access.
 * Concurrent calls on the same tab queue up; different tabs run in parallel.
 *
 * `lockTimeoutMs` (optional) should be the operation's own CDP timeout plus
 * headroom: the lock must outlive the cdpSend it guards, otherwise the lock
 * times out while the CDP call is still legitimately in flight.
 */
function beginCommand(ctx) {
  if (!ctx) return;
  if (ctx.ws?.__retired || (ctx.authenticationRequired && !ctx.ws?.__authenticated)) {
    throw new Error("command connection is no longer authenticated");
  }
  if (ctx.cancelled || (ctx.deadlineAt != null && Date.now() >= ctx.deadlineAt)) {
    throw new Error(ctx.cancelled ? "command cancelled before execution" : "command deadline expired before execution");
  }
  ctx.started = true;
}

async function withTabLock(tabId, clientId, fn, lockTimeoutMs = 60000, ctx) {
  const item = await tabLock.acquire(tabId, lockTimeoutMs);
  try {
    beginCommand(ctx);
    return await fn();
  } finally {
    tabLock.release(tabId, item);
  }
}

// ---------------- native brain ----------------
let nativePort = null;
let reconnectTimer = null;
let reconnectMs = 1000;
let hostIndex = 0;

function nativeHost() {
  return NATIVE_HOSTS[hostIndex % NATIVE_HOSTS.length];
}

// 诊断日志：service worker 没有 fs/require，能持久化跨重启写日志的唯一地方
// 是 chrome.storage.local。把 connectNative / detach 事件存进 wbDiagLog
// （最近 40 条），刷新扩展后从侧面板拉取（panel.diag 指令）或临时开
// 扩展的 devtools 看 storage。
function diagLog(line) {
  try {
    chrome.storage.local.get(["wbDiagLog"], (res) => {
      const arr = (res?.wbDiagLog || []).concat([new Date().toISOString().slice(5, 24) + " " + line]);
      chrome.storage.local.set({ wbDiagLog: arr.slice(-40) });
    });
  } catch (_) {}
}

function connectNative() {
  // 诊断锚点：记录扩展的真实 runtime ID + 正在尝试的 host 名。若 allowed_origins
  // 与 runtime ID 不一致，Edge 的 native-messaging 查找会在 lookup 阶段就报
  // "host not found"，这条日志能立刻把 ID 错位暴露出来。
  diagLog("connectNative: extId=" + (chrome.runtime?.id || "?") + " trying " + nativeHost());
  if (nativePort && nativePort.__alive) return true;
  if (nativePort) {
    // 旧 port 被标记为 dead（host 进程已退），先 detach 掉再重连，
    // 否则 return true 会骗面板"已连接"，但 port 实际已不可用。
    try { nativePort.onDisconnect?.removeListener?.(onNativeDisconnect); } catch (_) {}
    nativePort = null;
  }
  // Restart the round from the preferred (prod) host. hostIndex only
  // advances WITHIN a round; not resetting it drifts the fallback order so
  // that after N disconnects the list no longer starts at NATIVE_HOSTS[0].
  hostIndex = 0;
  for (;;) {
    try {
      diagLog("connectNative: trying " + nativeHost());
      nativePort = chrome.runtime.connectNative(nativeHost());
      reconnectMs = 1000; // reset backoff on success
      hostIndex = 0; // stick with the host that just accepted
      log("info", "native connected", { host: nativeHost() });
      diagLog("connectNative: OK " + nativeHost());
      nativePort.onMessage.addListener(onNativeMessage);
      nativePort.onDisconnect.addListener(onNativeDisconnect);
      return true;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log("warn", "connectNative failed, falling back to next host", { host: nativeHost(), err });
      diagLog("connectNative FAILED " + nativeHost() + ": " + err + " (lastError=" + (chrome.runtime.lastError?.message || "-") + ")");
      hostIndex++; // try the next host in the fallback list
      nativePort = null;
      if (hostIndex >= NATIVE_HOSTS.length * 2) {
        // exhausted the fallback list twice — back off and retry
        hostIndex = 0;
        scheduleReconnect();
        return false;
      }
    }
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectNative, reconnectMs);
  reconnectMs = Math.min(reconnectMs * 2, 30000); // capped backoff
}

function onNativeDisconnect() {
  const err = chrome.runtime.lastError?.message;
  log("warn", "native disconnected", { err: err || "closed" });
  diagLog("onNativeDisconnect: " + (err || "closed"));
  if (nativePort) nativePort.__alive = false; // 标记为 dead，面板不再假阳性
  nativePort = null;
  scheduleReconnect();
}

function onNativeMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  // 收到任何一条来自扩展的消息，证明 nativePort 确实活着。
  // 面板的 panel.status 用 nativePort.__alive 判断，避免假阳性。
  if (nativePort) nativePort.__alive = true;
  handleNativeCommand(msg).catch((e) => {
    brainSend({ type: "error", error: String(e) });
  });
}

// ---------------- brain command dispatch ----------------
const PANEL_CLIENT = "panel";

async function handleNativeCommand(msg) {
  const clientId = msg.clientId || msg.args?.clientId || "brain";
  switch (msg.type) {
    case "act.cdp": {
      // { tabId, method, params } -> run one CDP call, return result
      const { tabId, method, params } = msg;
      if (typeof tabId !== "number") { brainSend({ type: "cdp.result", id: msg.id, ok: false, error: "act.cdp: tabId must be a number" }); return; }
      acquireLease(clientId, tabId);
      const cdpTimeout = msg.timeoutMs || 20000;
      const res = await withTabLock(tabId, clientId, async () => {
        const s = await ensureAttached(tabId);
        const target = s.targetId ? { targetId: s.targetId } : { tabId };
        return cdpSend(target, method, params, cdpTimeout);
      }, lockMsForCdp(cdpTimeout, method)); // lock must outlive the CDP call (+ evaluate dialog retry)
      brainSend({ type: "cdp.result", id: msg.id, ok: true, result: res });
      return;
    }
    case "act.attach": {
      if (typeof msg.tabId !== "number") { brainSend({ type: "ok", id: msg.id, ok: false, error: "act.attach: tabId must be a number" }); return; }
      acquireLease(clientId, msg.tabId);
      await withTabLock(msg.tabId, clientId, () => ensureAttached(msg.tabId));
      brainSend({ type: "ok", id: msg.id, attached: true, tabId: msg.tabId, clientId });
      return;
    }
    case "act.detach": {
      if (typeof msg.tabId !== "number") { brainSend({ type: "ok", id: msg.id, ok: false, error: "act.detach: tabId must be a number" }); return; }
      await releaseLease(clientId, msg.tabId);
      brainSend({ type: "ok", id: msg.id, detached: true, tabId: msg.tabId, clientId });
      return;
    }
    case "tabs.list": {
      const all = await chrome.tabs.query({});
      brainSend({
        type: "tabs.result",
        id: msg.id,
        tabs: all.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active })),
      });
      return;
    }
    case "tabs.group": {
      // group task tabs together (mirrors tab-groups usage)
      const { tabIds, title } = msg;
      if (Array.isArray(tabIds) && tabIds.length) {
        const g = await chrome.tabGroups.create({ tabIds, title: title || "wb-task" });
        brainSend({ type: "ok", id: msg.id, groupId: g.id });
      }
      return;
    }
    case "diag":
      brainSend({
        type: "diag",
        id: msg.id,
        tabs: [...tabs.entries()].map(([tabId, s]) => ({ tabId, attached: s.attached, targetId: s.targetId })),
        clients: [...clientLeases.entries()].map(([cid, set]) => ({ clientId: cid, tabs: [...set] })),
        lockQueue: tabLock.keys(),
        log: logBuf.slice(-50),
      });
      return;
    case "agent.cmd": {
      // An agent request (from the WS bridge or the native host) forwarded to us.
      // Execute in the browser, reply with agent.result (matching id). The work
      // lives in execAgentCmd so both the WS and native channels share it.
      const { cmd, args, id } = msg;
      const client = args?.clientId || clientId;
      execAgentCmd(cmd, args, client)
        .then((result) => brainSend({ type: "agent.result", id, ok: true, result }))
        .catch((e) => brainSend({ type: "agent.result", id, ok: false, error: String(e.message || e) }));
      return;
    }
    default:
      brainSend({ type: "unknown", id: msg.id, cmd: msg.type });
  }
}

function brainSend(obj) {
  if (nativePort) {
    try {
      nativePort.postMessage(obj);
    } catch (e) {
      log("warn", "brain send failed", { error: String(e) });
    }
  }
}

// ---------------- agent command execution (shared by WS + native channels) ---
// execAgentCmd runs one agent request and RESOLVES with the result (or throws).
// Channel-specific reply routing (WS socket vs native port) stays in the
// caller — this function is pure work, so both bridges reuse the exact same
// CDP logic, tab locks, and client leases.
// ---------------- 索引化动作空间（snapshot / click-el / type-el） ----------------
// 引入自 browser-use/jev-ultrafast 的思想：agent 不手写选择器 JS，而是从
// 快照索引里选编号 + 标签；执行前重新解析校验（stale 则明示，不静默点空）。
// 动作空间是白名单（click/type），不是全 JS 通道。
// 页内候选枚举规则（snapshot 与 resolve 必须完全一致，否则索引失配）：
const EL_CANDIDATE_SEL =
  'input,button,select,textarea,a,[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[data-testid]';

// 收集器（snapshot 与 act 同源注入同一份源码）：document 级枚举 + open
// shadowRoot 递归。T-30 实证不递归时 shreddit 类 shadow 站整体不可见。
const EL_COLLECTOR_SRC =
  "function labelOf(e){return (e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('name')) || String((e.innerText||e.textContent||'').trim()).slice(0,24);}" +
  "function __elNodes(){" +
  "var SEL=" + JSON.stringify(EL_CANDIDATE_SEL) + ";" +
  "var out=[];" +
  "function collect(root){var els=root.querySelectorAll(SEL);for(var k=0;k<els.length;k++)out.push(els[k]);" +
  "var hosts=root.querySelectorAll('*');for(var h=0;h<hosts.length;h++){var sr=null;try{sr=hosts[h].shadowRoot;}catch(_){}" +
  "if(sr)collect(sr);}}" +
  "collect(document);" +
  "return [].filter.call(out,function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled;});" +
  "}";

function snapshotExpr(max) {
  const m = Number(max) > 0 ? Number(max) : 50;
  return (
    "(function(){" + EL_COLLECTOR_SRC +
    "var nodes=__elNodes();" +
    "var items=nodes.slice(0," + m + ").map(function(e,i){return {i:i,tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',label:labelOf(e)};});" +
    "return JSON.stringify({url:location.href,ts:Date.now(),total:nodes.length,count:items.length,items:items});})()"
  );
}

// act: "click" | "type"；typeText 以 "__CLEAR__" 前缀表示先清空；
// el = 快照条目 {i,tag,role,label}。解析校验：索引在界内 + label 未漂移。
// 动作执行期间临时接管 alert/confirm/prompt（T-30：Edge 的 chrome.debugger
// 不派发 javascriptDialogOpening，弹窗会把 evaluate 卡到超时且
// handleJavaScriptDialog 报 "No dialog is showing" 解不掉）。同步包裹、
// finally 恢复原生函数，页面事后观察不到覆写。
const ACT_QUIET_DIALOGS_SRC =
  "function withQuietDialogs(fn){var w=typeof window==='undefined'?null:window;if(!w||!w.alert)return fn();" +
  "var oa=w.alert,oc=w.confirm,op=w.prompt;" +
  "try{w.alert=function(){};w.confirm=function(){return true;};w.prompt=function(d){return d==null?'':d;};}catch(_){}" +
  "try{return fn();}finally{try{w.alert=oa;w.confirm=oc;w.prompt=op;}catch(_){}}}";

function actExpr(el, act, typeText) {
  return (
    "(function(el,act,txt){" + EL_COLLECTOR_SRC + ACT_QUIET_DIALOGS_SRC +
    "var nodes=__elNodes();" +
    "if(!(el.i>=0&&el.i<nodes.length)) return JSON.stringify({found:false,reason:'索引越界：页面已变化，请重新 snapshot'});" +
    "var target=nodes[el.i],label=labelOf(target);" +
    "if(el.label&&String(el.label).length&&label!==String(el.label))" +
    " return JSON.stringify({found:false,reason:'label 漂移：期望 '+JSON.stringify(el.label)+' 实际 '+JSON.stringify(label)+'，请重新 snapshot'});" +
    "if(act==='click'){withQuietDialogs(function(){target.click();});return JSON.stringify({found:true,clicked:label,rect:[Math.round(target.getBoundingClientRect().x),Math.round(target.getBoundingClientRect().y)]});}" +
    "if(act==='type'){var clear=typeof txt==='string'&&txt.indexOf('__CLEAR__')===0;if(clear){txt=String(txt).slice(9);try{target.value='';}catch(_){}}var proto=target.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set){d.set.call(target,txt);}else{target.value=txt;}withQuietDialogs(function(){target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));});return JSON.stringify({found:true,typed:target.value});}" +
    "return JSON.stringify({found:false,reason:'未知动作 '+JSON.stringify(act)});})" +
    "(" + JSON.stringify(el) + "," + JSON.stringify(act) + "," + JSON.stringify(typeText == null ? "" : typeText) + ")"
  );
}

async function execAgentCmd(cmd, args, clientId, ctx) {
  switch (cmd) {
    case "tabs": {
      const all = await chrome.tabs.query({});
      return all.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active }));
    }
    case "capture.start": {
      const { tabId, domains, durationMs } = args || {};
      if (!Number.isInteger(tabId)) throw new Error("capture.start: need integer tabId");
      const doms = [...new Set(Array.isArray(domains) && domains.length ? domains : ["Network"])];
      if (!doms.every((d) => typeof d === "string" && /^[A-Za-z]+$/.test(d))) {
        throw new Error("capture.start: invalid domain");
      }
      const dur = Number.isFinite(durationMs) && durationMs > 0 ? Math.min(durationMs, 2147483647) : 30000;
      if (ctx?.ws == null) throw new Error("capture.start: WS channel only");
      return withTabLock(tabId, clientId, async () => {
        for (const other of captureSessions.values()) {
          if (other.active && other.clientId === clientId && other.tabId === tabId) {
            throw new Error("capture.start: a capture session is already active for this tab+client (stop it first)");
          }
        }
        const enabled = [];
        const s = await ensureAttached(tabId);
        const target = s.targetId ? { targetId: s.targetId } : { tabId };
        try {
          for (const d of doms) {
            if (captureUsesDomain(tabId, d)) continue;
            await cdpSend(target, d + ".enable", {}, 15000);
            enabled.push(d);
          }
          const captureId = "cap-" + Date.now().toString(36) + "-" + (++captureSequence);
          const sess = { captureId, clientId, tabId, domains: doms, ws: ctx.ws, wsPort: ctx.wsPort, active: true, timer: null };
          sess.timer = setTimeout(() => stopCapture(captureId).catch((e) => log("warn", "capture cleanup failed", { error: String(e) })), dur);
          captureSessions.set(captureId, sess);
          log("info", "capture started", { captureId, tabId, domains: doms, durationMs: dur });
          return { started: true, captureId, tabId, domains: doms, durationMs: dur };
        } catch (e) {
          for (const d of enabled) {
            if (!captureUsesDomain(tabId, d)) await cdpSend(target, d + ".disable", {}, 5000).catch(() => {});
          }
          if (!hasTabLease(tabId)) await doDetach(tabId);
          throw e;
        }
      }, 60000, ctx);
    }
    case "capture.stop": {
      const { tabId, captureId } = args || {};
      const sess = captureId
        ? captureSessions.get(captureId)
        : [...captureSessions.values()].find((s) => s.active && s.clientId === clientId && s.tabId === tabId && (!ctx?.ws || s.ws === ctx.ws));
      if (!sess) return { stopped: false, reason: "no active capture session" };
      if (sess.clientId !== clientId || (ctx?.ws && sess.ws !== ctx.ws)) throw new Error("capture.stop: session belongs to another client");
      beginCommand(ctx);
      return stopCapture(sess.captureId);
    }
    // 索引化动作空间：snapshot 枚举可交互控件；click-el/type-el 按快照条目
    // 定位（执行前重解析校验，stale 则报不执行）。
    case "snapshot": {
      const { tabId, max } = args || {};
      if (typeof tabId !== "number") throw new Error("snapshot: tabId must be a number");
      return await withTabLock(tabId, clientId, async () => {
        acquireLease(clientId, tabId);
        const s = await ensureAttached(tabId);
        const target = s.targetId ? { targetId: s.targetId } : { tabId };
        const r = await cdpSend(target, "Runtime.evaluate", { expression: snapshotExpr(max), returnByValue: true }, 15000);
        const v = r && r.result ? r.result.value : null;
        return v != null ? JSON.parse(v) : { error: "snapshot evaluate returned nothing" };
      }, 45000, ctx); // 锁须覆盖 evaluate 的弹窗重试（2×15s+6s）
    }
    case "click-el": {
      const { tabId, el } = args || {};
      if (typeof tabId !== "number" || !el || typeof el.i !== "number") throw new Error("click-el: need tabId + el{i,label}（来自 snapshot）");
      return await withTabLock(tabId, clientId, async () => {
        acquireLease(clientId, tabId);
        const s = await ensureAttached(tabId);
        const target = s.targetId ? { targetId: s.targetId } : { tabId };
        const r = await cdpSend(target, "Runtime.evaluate", { expression: actExpr(el, "click", ""), returnByValue: true }, 15000);
        const v = r && r.result ? r.result.value : null;
        return v != null ? JSON.parse(v) : { found: false, reason: "evaluate returned nothing" };
      }, 45000, ctx); // 锁须覆盖 evaluate 的弹窗重试（2×15s+6s）
    }
    case "type-el": {
      const { tabId, el, text, clear } = args || {};
      if (typeof tabId !== "number" || !el || typeof el.i !== "number" || typeof text !== "string") throw new Error("type-el: need tabId + el + text");
      return await withTabLock(tabId, clientId, async () => {
        acquireLease(clientId, tabId);
        const s = await ensureAttached(tabId);
        const target = s.targetId ? { targetId: s.targetId } : { tabId };
        const payload = clear ? "__CLEAR__" + text : text;
        const r = await cdpSend(target, "Runtime.evaluate", { expression: actExpr(el, "type", payload), returnByValue: true }, 15000);
        const v = r && r.result ? r.result.value : null;
        return v != null ? JSON.parse(v) : { found: false, reason: "evaluate returned nothing" };
      }, 45000, ctx); // 锁须覆盖 evaluate 的弹窗重试（2×15s+6s）
    }
    case "cdp": {
      const { tabId, method, params } = args || {};
      if (typeof tabId !== "number") throw new Error("cdp: tabId must be a number");
      const cdpTimeout = args.timeoutMs || 20000;
      return await withTabLock(tabId, clientId, async () => {
        acquireLease(clientId, tabId);
        const s = await ensureAttached(tabId);
        const target = s.targetId ? { targetId: s.targetId } : { tabId };
        return cdpSend(target, method, params, cdpTimeout);
      }, lockMsForCdp(cdpTimeout, method), ctx);
    }
    case "setfile": {
      const { tabId, selector, files } = args || {};
      if (typeof tabId !== "number") throw new Error("setfile: tabId must be a number");
      if (typeof selector !== "string" || !Array.isArray(files)) throw new Error("setfile: need selector + files[]");
      return await withTabLock(tabId, clientId, async () => {
        acquireLease(clientId, tabId);
        const s = await ensureAttached(tabId);
        const target = s.targetId ? { targetId: s.targetId } : { tabId };
        const doc = await cdpSend(target, "DOM.getDocument", { depth: 1 });
        const rootId = doc && doc.root && doc.root.nodeId;
        const q = await cdpSend(target, "DOM.querySelectorAll", { nodeId: rootId, selector });
        const ids = (q && q.nodeIds) || [];
        if (!ids.length) throw new Error("setfile: no element matches " + selector);
        await cdpSend(target, "DOM.setFileInputFiles", { files, nodeId: ids[0] });
        return { ok: true, matched: ids.length };
      }, 30000, ctx);
    }
    case "navigate": {
      // 用 chrome.tabs.update 导航（不需要 attach）：edge:// 等内部页面
      // chrome.debugger 无法附加（attach did not stick），CDP Page.navigate
      // 因此在这类标签上永远失败；tabs API 对所有标签都有效。
      // 默认等 load（T-30：不等 load 时慢站立刻 run 拿到空 DOM）；
      // waitMs<=0 跳过等待。
      const { tabId, url } = args || {};
      if (typeof tabId !== "number" || typeof url !== "string") throw new Error("navigate: need numeric tabId + string url");
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
      // 默认等 load（T-30 修复）；waitMs<=0 跳过。
      const waitMs = args.waitMs == null ? 15000 : Number(args.waitMs);
      const load = await waitTabComplete(t.id, waitMs);
      return { opened: true, tabId: t.id, url, ...load };
    }
    case "open-frame": {
      // 跨源 iframe 内容触达不了（OOPIF 硬限制，T-30）时的回退：从
      // Page.getFrameTree 找 URL 匹配的子帧，直接开成顶层标签（登录态同源带走）。
      const { tabId, urlPattern } = args || {};
      if (typeof tabId !== "number") throw new Error("open-frame: tabId must be a number");
      if (typeof urlPattern !== "string" || !urlPattern) throw new Error("open-frame: need urlPattern regex string");
      const re = new RegExp(urlPattern, "i");
      return await withTabLock(tabId, clientId, async () => {
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
          return { opened: false, reason: "no frame matches " + urlPattern, frames: frames.map((f) => f.url) };
        }
        const t = await chrome.tabs.create({ url: hit.url, active: true });
        const load = await waitTabComplete(t.id, 15000);
        return { opened: true, tabId: t.id, frameUrl: hit.url, frameOrigin: hit.securityOrigin || "", ...load };
      }, 45000, ctx);
    }
    case "close": {
      if (typeof args?.tabId !== "number") throw new Error("close: need numeric tabId");
      beginCommand(ctx);
      await chrome.tabs.remove(args.tabId);
      return { closed: true, tabId: args.tabId };
    }
    case "attach": {
      if (typeof args?.tabId !== "number") throw new Error("attach: tabId must be a number");
      await withTabLock(args.tabId, clientId, () => {
        acquireLease(clientId, args.tabId);
        return ensureAttached(args.tabId);
      }, 60000, ctx);
      return { attached: true, tabId: args.tabId };
    }
    case "detach": {
      if (typeof args?.tabId !== "number") throw new Error("detach: need numeric tabId");
      if (args.force) {
        // 强制物理 detach（清掉本扩展自己残留的 debugger 会话）
        await withTabLock(args.tabId, clientId, () => doDetach(args.tabId), 60000, ctx);
        return { detached: true, forced: true, tabId: args.tabId };
      }
      beginCommand(ctx);
      await releaseLease(clientId, args.tabId);
      return { detached: true, tabId: args.tabId };
    }
    case "diag": {
      const [diagRes, wsRes] = await Promise.all([
        new Promise((resolve) => {
          chrome.storage.local.get(["wbDiagLog"], (r) => resolve(r?.wbDiagLog || []));
        }),
        new Promise((resolve) => {
          chrome.storage.local.get(["wbWsLog"], (r) => resolve(r?.wbWsLog || []));
        }),
      ]);
      return {
        nativeConnected: !!nativePort && nativePort.__alive !== false,
        wsAgents: agentWsPortsUp(),
        log: diagRes,
        wsLog: wsRes,
        dialogs: [...lastDialogs.entries()].map(([tid, d]) => ({ tabId: tid, ...d })),
      };
    }
    default:
      throw new Error("unknown agent cmd: " + cmd);
  }
}

// ---------------- agent WS bridge (primary channel) ----------------
// The native-messaging path (connectNative -> host.js) is unreliable on this
// machine: Edge's spawn/lookup of our host returns "not found" even with a
// correct registry entry. The robust channel is the REVERSED one: agent apps
// run a loopback WebSocket server (agent-collect.js) and THIS worker dials
// OUT to it. Outbound WS always works from a browser, needs no registry, no
// spawn, and an open socket keeps the MV3 service worker alive.
// T-33：多会话并发下 10 个端口不够（每个会话的 serve/--keep 桥 + one-shot 直连
// 各占一个），扩到 20 个。agent 侧默认段须与此一致（WB_AGENT_WS_START/END
// 覆盖 agent 段时，扩展仍按本数组拨号——超出 9521-9540 的自定义段需手动同步）。
const AGENT_WS_PORTS = [9521, 9522, 9523, 9524, 9525, 9526, 9527, 9528, 9529, 9530, 9531, 9532, 9533, 9534, 9535, 9536, 9537, 9538, 9539, 9540];
/** port -> Set<WebSocket>：同一 agent server 端口上可能并发挂多条 socket
 * （常驻 bridge daemon + 临时 one-shot 客户端）。每条 socket 独立管理
 * 生命周期与结果路由，互不顶替。 */
const agentWs = new Map();
/** port -> 冷却截止时间戳：拨号失败（从未 open）的端口 15s 内不再拨，
 * 防止 bridge 真空期"10 端口 × 每 5s"的拒绝风暴堆积 socket 耗尽 Edge 的
 * 网络缓冲（T-32 事故：ERR_NO_BUFFER_SPACE + SYN_SENT 卡死）。 */
const portCooldown = new Map();
const wsClientOwners = new Map(); // clientId -> authenticated socket; prevents cross-bridge lease collisions
let wsRescanTimer = null;
let wsPingTimer = null;
let bridgeToken = null;
let tokenLoaded = false;
let connectingAgentWs = null;

function loadBridgeToken() {
  // 鉴权标识是两侧内置的固定常量（ws-auth.js 的 DEFAULT_TOKEN），
  // 不读 storage、不需要用户配对：扩展与 agent 同时更新即可。
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
    await Promise.allSettled([...captureSessions.values()]
      .filter((s) => s.clientId === clientId && s.ws === ws)
      .map((s) => stopCapture(s.captureId)));
    // Another socket is never permitted to claim this identity until cleanup
    // completes, including when pairing rotates or the bridge reconnects.
    if (releaseLeases && wsClientOwners.get(clientId) === ws) {
      for (const tabId of [...(clientLeases.get(clientId) || [])]) await releaseLease(clientId, tabId);
    }
    if (wsClientOwners.get(clientId) === ws) wsClientOwners.delete(clientId);
  })().finally(() => ws.__disconnecting.delete(clientId));
  ws.__disconnecting.set(clientId, cleanup);
  return cleanup;
}

function claimWsClient(ws, clientId) {
  const owner = wsClientOwners.get(clientId);
  if (owner && owner !== ws) throw new Error("clientId is active on another connection");
  wsClientOwners.set(clientId, ws);
}

// WS 通道诊断（持久化到 chrome.storage.local.wbWsLog，最近 40 条）。
// 排查"agent 起 server 但扩展连不进来"用：重载扩展后从 leveldb 读。
function wsLog(line) {
  try {
    chrome.storage.local.get(["wbWsLog"], (res) => {
      const arr = (res?.wbWsLog || []).concat([new Date().toISOString().slice(5, 24) + " " + line]);
      chrome.storage.local.set({ wbWsLog: arr.slice(-40) });
    });
  } catch (_) {}
}

function agentWsPortsUp() {
  return [...agentWs.entries()]
    .filter(([, set]) => [...set].some((ws) => ws.readyState === WebSocket.OPEN && ws.__authenticated))
    .map(([p]) => p);
}

// 定向发给某条 socket（结果路由用：cmd 从哪条来，result 就回哪条，
// 同端口的其它 socket 不受影响）。best-effort，socket 已死则丢弃。
function wsSendTo(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { log("warn", "ws send failed", { error: String(e) }); }
  }
  return false;
}

// 广播到某端口上所有 OPEN socket（ping / welcome 等与具体会话无关的消息）
function sendWs(port, obj) {
  let sent = false;
  const set = agentWs.get(port);
  if (set) for (const ws of set) sent = wsSendTo(ws, obj) || sent;
  return sent;
}

async function onWsMessage(ws, port, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== "object" || ws.__retired) return;
  if (m.type === "auth.challenge" && !ws.__authenticated) {
    if (ws.__auth || m.protocol !== WSAuth.PROTOCOL || !WSAuth.validToken(m.nonce) || !bridgeToken) {
      ws.close(); return;
    }
    const auth = { serverNonce: m.nonce, clientNonce: WSAuth.createNonce(), token: bridgeToken };
    ws.__auth = auth;
    try {
      const proof = await WSAuth.sign(auth.token, "extension", "client", auth.serverNonce, auth.clientNonce);
      if (ws.__retired) return;
      wsSendTo(ws, { type: "auth.response", protocol: WSAuth.PROTOCOL, role: "extension", nonce: auth.clientNonce, proof, extId: chrome.runtime?.id });
    } catch (_) { ws.close(); }
    return;
  }
  if (m.type === "auth.ok" && !ws.__authenticated) {
    const auth = ws.__auth;
    if (!auth || m.protocol !== WSAuth.PROTOCOL ||
        !await WSAuth.verify(auth.token, "extension", "server", auth.serverNonce, auth.clientNonce, m.proof) || ws.__retired) {
      ws.close(); return;
    }
    ws.__authenticated = true;
    ws.__auth = null;
    clearTimeout(ws.__authTimer);
    log("info", "agent ws authenticated", { port });
    return;
  }
  if (!ws.__authenticated) { ws.close(); return; }
  if (m.type === "cmd" || m.type === "agent.cmd") {
    const { id, cmd, args, clientId, deadlineAt, transientClient } = m;
    if (typeof id !== "string" || typeof clientId !== "string" || !clientId ||
        (deadlineAt != null && !Number.isFinite(deadlineAt))) {
      wsSendTo(ws, { type: "agent.result", id, ok: false, error: "invalid command identity or deadline" });
      return;
    }
    ws.__requests ||= new Map();
    ws.__clients ||= new Map();
    if (ws.__requests.has(id)) { wsSendTo(ws, { type: "agent.result", id, ok: false, error: "duplicate in-flight request id" }); return; }
    ws.__clients.set(clientId, transientClient !== false);
    const priorCleanup = ws.__disconnecting?.get(clientId);
    const ctx = { ws, wsPort: port, clientId, deadlineAt, cancelled: false, started: false, authenticationRequired: true, completion: null };
    ws.__requests.set(id, ctx);
    ctx.completion = Promise.resolve().then(async () => {
      if (priorCleanup) await priorCleanup;
      if (ws.__retired || !ws.__authenticated) throw new Error("command connection is no longer authenticated");
      if (ctx.cancelled || (deadlineAt != null && Date.now() >= deadlineAt)) throw new Error("command cancelled or deadline expired before execution");
      claimWsClient(ws, clientId);
      return execAgentCmd(cmd, args, clientId, ctx);
    }).then((result) => wsSendTo(ws, { type: "agent.result", id, ok: true, result }))
      .catch((e) => wsSendTo(ws, { type: "agent.result", id, ok: false, error: String(e.message || e) }))
      .finally(() => ws.__requests.delete(id));
    return ctx.completion;
  }
  if (m.type === "cancel") {
    const ctx = ws.__requests?.get(m.id);
    if (ctx && !ctx.started) ctx.cancelled = true;
    return;
  }
  if (m.type === "client.disconnect" && typeof m.clientId === "string" && ws.__clients?.has(m.clientId)) {
    await disconnectClient(ws, m.clientId, m.releaseLeases !== false);
    if (m.id != null) wsSendTo(ws, { type: "agent.result", id: m.id, ok: true, result: { disconnected: true, clientId: m.clientId } });
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
      try { ws = new WebSocket("ws://127.0.0.1:" + port); } catch (_) { continue; }
      const set = new Set([ws]);
      agentWs.set(port, set);
      ws.__requests = new Map();
      ws.__clients = new Map();
      ws.__authenticated = false;
      ws.__authTimer = setTimeout(() => { if (!ws.__authenticated) ws.close(); }, 5000);
      // 拨号看门狗：SYN_SENT 卡死（loopback 对死端口偶发不回 RST，T-32）时，
      // 10s 内没 open 就强制 close 走 onclose 冷却，而不是让死 socket 永久
      // 占住该端口（set.size>0 会跳过重拨）。
      ws.__dialTimer = setTimeout(() => { if (!ws.__opened) { try { ws.close(); } catch (_) {} } }, 10000);
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
        ws.__incoming = (ws.__incoming || Promise.resolve()).then(async () => {
          if (!ws.__authenticated) await onWsMessage(ws, port, ev.data);
          else onWsMessage(ws, port, ev.data).catch(() => { try { ws.close(); } catch (_) {} });
        }).catch(() => { try { ws.close(); } catch (_) {} });
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
        // 从未 open 的失败拨号进 15s 冷却（T-32）：把 bridge 真空期的空转拨号
        // 降一个量级。bridge 掉线（open 过再 close）不冷却，仍 5s 快速重连。
        if (!wasOpen) portCooldown.set(port, Date.now() + 15000);
        for (const [clientId, transientClient] of [...ws.__clients]) disconnectClient(ws, clientId, transientClient).catch((e) => log("warn", "client cleanup failed", { error: String(e) }));
        wsLog("port " + port + " CLOSED");
        scheduleWsRescan();
      };
      ws.onerror = () => {};
    }
    scheduleWsRescan();
  })();
  try { return await connectingAgentWs; } finally { connectingAgentWs = null; }
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
  if (typeof msg?.type !== "string" || !msg.type.startsWith("panel.")) return false;
  (async () => {
    switch (msg?.type) {
      case "panel.status": {
        if (!tokenLoaded) await loadBridgeToken();
        // 反映真实连接状态。WS 桥（主通道）：agentWsPortsUp() 非空即有 agent
        // 连入；native（可选备用）：nativePort 存活。两者都可能是空。
        const wsUp = agentWsPortsUp();
        sendResponse({
          ok: true,
          wsAgents: wsUp,
          wsConnected: wsUp.length > 0,
          nativeConnected: !!nativePort && nativePort.__alive !== false,
        });
        return;
      }
      case "panel.diag": {
        // 诊断：吐日志 + 当前 WS / native 状态。
        chrome.storage.local.get(["wbDiagLog"], (res) => {
          sendResponse({
            ok: true,
            nativeConnected: !!nativePort && nativePort.__alive !== false,
            log: res?.wbDiagLog || [],
          });
        });
        return;
      }
      case "panel.connectNative":
        sendResponse({ ok: connectNative(), host: nativeHost() });
        break;
      case "panel.cdp": {
        // direct CDP call from the panel UI: { tabId, method, params }
        // Serialized on the tab so it never interleaves with an agent's CDP.
        const tabId = msg.tabId;
        if (typeof tabId !== "number") { sendResponse({ ok: false, error: "panel.cdp: tabId must be a number" }); break; }
        acquireLease(PANEL_CLIENT, tabId);
        const cdpTimeout = msg.timeoutMs || 15000;
        const result = await withTabLock(tabId, PANEL_CLIENT, async () => {
          const s = await ensureAttached(tabId);
          return cdpSend(
            s.targetId ? { targetId: s.targetId } : { tabId },
            msg.method,
            msg.params || {},
            cdpTimeout,
          );
        }, lockMsForCdp(cdpTimeout, msg.method));
        sendResponse({ ok: true, result });
        break;
      }
      case "panel.attach":
        if (typeof msg.tabId !== "number") { sendResponse({ ok: false, error: "panel.attach: tabId must be a number" }); break; }
        acquireLease(PANEL_CLIENT, msg.tabId);
        await withTabLock(msg.tabId, PANEL_CLIENT, () => ensureAttached(msg.tabId));
        sendResponse({ ok: true });
        break;
      case "panel.detach":
        if (typeof msg.tabId !== "number") { sendResponse({ ok: false, error: "panel.detach: tabId must be a number" }); break; }
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
      nativeConnected: !!nativePort,
      tabs: [...tabs.entries()].map(([id, s]) => ({ tabId: id, attached: s.attached })),
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

// Auto-connect on install/startup. The PRIMARY channel is the agent WS bridge
// (agent apps run a loopback WS server; this worker dials out to it). The
// native-messaging channel is kept only as an optional manual fallback —
// Edge on this machine never spawns our host ("not found"), so auto
// connectNative is deliberately NOT called: it would just log error loops.
// MV3 SWs are lazy: onStartup is what makes the browser boot us at launch,
// and a 30s keepalive alarm re-dials the WS bridge if we ever went idle.
//
// 仅在真实浏览器 SW 里自动拨号：chrome.runtime.id 在 SW 中恒有值，
// node 测试 mock 没有 —— 避免测试环境真的去连 127.0.0.1。
const IS_BROWSER_SW = !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
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
    if (alarm?.name === "wb-agent-ws-keepalive" && IS_BROWSER_SW) connectAgentWs();
  });
}

// Test-only handle (module is undefined in a service worker, so this is a
// no-op in the browser).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    connectNative,
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
