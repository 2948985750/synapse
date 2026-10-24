"use strict";
// CDP 传输层：把 chrome.debugger.sendCommand 包成有超时、可重试的原语。
//
// 抽出来的理由：这三件事和"业务命令"无关，任何 CDP 客户端都需要
//   1) 每次 sendCommand 都有硬超时（挂着不返回的 CDP 调用会永久占住 tab 锁）
//   2) Runtime.evaluate 超时按"页面弹窗"处理，等一次再试（T-30 实测弹窗 ~5s 自愈）
//   3) 锁超时必须覆盖最坏重试路径（lockMsForCdp），否则锁先超时、命令还在跑
//   4) 等标签加载完成（open/navigate 后立刻 run 会拿到空 DOM）
//
// 依赖注入：chromeApi + log 都从外部给，方便在 node 里用 mock 跑单测。
// 交付形态：经典脚本（importScripts 加载），同时挂 globalThis 与 module.exports。

function createCdpTransport(options = {}) {
  const chromeApi = options.chromeApi || chrome;
  const log = options.log || (() => {});
  const CDP_VERSION = options.cdpVersion || "1.3";
  const DIALOG_RETRY_WAIT_MS = options.dialogRetryWaitMs || 6000;
  const DEFAULT_TIMEOUT_MS = options.defaultTimeoutMs || 15000;

  // cdpSend 把任意 Domain.method 原样转发给已附加的 tab：不设域白名单、不设方法
  // 黑名单，扩展是"全量透传"。唯一保留的结构性校验：method 必须是非空字符串。
  function methodAllowed(method) {
    if (typeof method !== "string" || !method) {
      throw new Error(
        "cdpSend: method must be a non-empty string like 'Domain.method'",
      );
    }
    return true;
  }

  async function sendOnce(target, method, params, timeoutMs) {
    methodAllowed(method);
    const t =
      typeof target?.targetId === "string"
        ? { targetId: target.targetId }
        : target; // { tabId } form
    // 把 CDP 调用和真实定时器赛跑：挂起的 sendCommand 不能把 tab 锁永占。
    let timerId;
    const timeout = new Promise((_, rej) => {
      timerId = setTimeout(
        () => rej(new Error(`CDP timeout: ${method}`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([
        chromeApi.debugger.sendCommand(t, method, params || {}),
        timeout,
      ]);
    } finally {
      clearTimeout(timerId);
    }
  }

  async function send(target, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    try {
      return await sendOnce(target, method, params, timeoutMs);
    } catch (e) {
      if (
        method === "Runtime.evaluate" &&
        /CDP timeout/.test(String((e && e.message) || e))
      ) {
        log("warn", "Runtime.evaluate timeout — suspected modal dialog, retrying once", {
          waitMs: DIALOG_RETRY_WAIT_MS,
        });
        await new Promise((r) => setTimeout(r, DIALOG_RETRY_WAIT_MS));
        try {
          return await sendOnce(target, method, params, timeoutMs);
        } catch (e2) {
          throw new Error(
            "Runtime.evaluate 超时两次（疑似页面原生弹窗卡住该标签）——close 该 tab 或人工处理弹窗后重试：" +
              String((e2 && e2.message) || e2),
          );
        }
      }
      throw e;
    }
  }

  // 锁超时：锁必须活得比 CDP 调用久；Runtime.evaluate 有弹窗重试，
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
    if (!Number.isFinite(waitMs) || waitMs <= 0)
      return { loaded: false, waitMs: 0 };
    const t0 = Date.now();
    for (;;) {
      try {
        const t = await chromeApi.tabs.get(tabId);
        if (t.status === "complete")
          return { loaded: true, waitMs: Date.now() - t0 };
      } catch (_) {
        return { loaded: false, waitMs: Date.now() - t0, gone: true };
      }
      if (Date.now() - t0 >= waitMs) return { loaded: false, waitMs };
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return {
    CDP_VERSION,
    DIALOG_RETRY_WAIT_MS,
    DEFAULT_TIMEOUT_MS,
    methodAllowed,
    sendOnce,
    send,
    lockMsForCdp,
    waitTabComplete,
  };
}

const CdpTransport = { createCdpTransport };
if (typeof globalThis !== "undefined") Object.assign(globalThis, CdpTransport);
if (typeof module !== "undefined" && module.exports) module.exports = CdpTransport;
