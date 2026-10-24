"use strict";
// CDP transport: chrome.debugger.sendCommand wrapped into timed, retryable primitives.
//
// Extracted because none of this is business logic — every CDP client needs it:
//   1) a hard timeout per sendCommand (a hanging call would hold the tab lock
//      forever);
//   2) Runtime.evaluate timeouts treated as a page dialog, retried once after a wait;
//   3) a lock budget that covers the worst retry path (lockMsForCdp);
//   4) waiting for the tab to finish loading (an immediate run sees an empty DOM).
//
// chromeApi and log are injected so the module is unit-testable in node.
// Shipped as a classic script; exports also land on globalThis and module.exports.

function createCdpTransport(options = {}) {
  const chromeApi = options.chromeApi || chrome;
  const log = options.log || (() => {});
  const CDP_VERSION = options.cdpVersion || "1.3";
  const DIALOG_RETRY_WAIT_MS = options.dialogRetryWaitMs || 6000;
  const DEFAULT_TIMEOUT_MS = options.defaultTimeoutMs || 15000;

  // send forwards any Domain.method straight to the attached tab: no domain
  // allow-list, no method block-list — the extension is a full CDP passthrough.
  // The only structural guard left: method must be a non-empty string.
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
    // Race the CDP call against a real timer: a hanging sendCommand must not hold the lock.
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
        log(
          "warn",
          "Runtime.evaluate timeout — suspected modal dialog, retrying once",
          {
            waitMs: DIALOG_RETRY_WAIT_MS,
          },
        );
        await new Promise((r) => setTimeout(r, DIALOG_RETRY_WAIT_MS));
        try {
          return await sendOnce(target, method, params, timeoutMs);
        } catch (e2) {
          throw new Error(
            "Runtime.evaluate timed out twice (a native page dialog is likely blocking this tab) — close the tab or dismiss the dialog and retry: " +
              String((e2 && e2.message) || e2),
          );
        }
      }
      throw e;
    }
  }

  // Lock budget: the lock must outlive the CDP call. Runtime.evaluate has the
  // dialog retry (worst case 2×timeoutMs + 6s); everything else 1×timeoutMs + 5s.
  function lockMsForCdp(cdpTimeoutMs, method) {
    return method === "Runtime.evaluate"
      ? 2 * cdpTimeoutMs + DIALOG_RETRY_WAIT_MS + 5000
      : cdpTimeoutMs + 5000;
  }

  // Poll until the tab finishes loading (T-30: open/navigate do not wait for
  // load, so a slow site returns an empty DOM on an immediate run).
  // status=complete returns loaded:true; the waitMs deadline returns loaded:false;
  // a closed tab returns gone:true. waitMs<=0 skips the polling entirely.
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
if (typeof module !== "undefined" && module.exports)
  module.exports = CdpTransport;
