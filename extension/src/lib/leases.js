"use strict";
// Lease manager: per-client tab leases + the per-tab FIFO lock.
//
// Model (unchanged from the original background.js implementation):
//   - every client (agent conversation) holds its own lease set;
//   - CDP *operations* on one tab are serialized by TabLock (tablock.js), so
//     two conversations never interleave on the same tab;
//   - attach/detach themselves run under that lock (chrome.debugger.attach on
//     an already-attached tab throws, so it must be exclusive);
//   - a physical detach happens only when no client (and no capture session)
//     still holds the tab.
//
// Dependencies are injected (tabLock, detach, hasCaptureOnTab, log) so this can
// be tested without a browser. Loaded via importScripts as a classic script.

function createLeaseManager(deps = {}) {
  const tabLock = deps.tabLock;
  const detach = deps.detach || (async () => {});
  const hasCaptureOnTab = deps.hasCaptureOnTab || (() => false);
  const log = deps.log || (() => {});
  const defaultLockTimeoutMs = deps.defaultLockTimeoutMs || 60000;

  const clientLeases = new Map(); // clientId -> Set<tabId>

  function leaseFor(clientId) {
    let l = clientLeases.get(clientId);
    if (!l) {
      l = new Set();
      clientLeases.set(clientId, l);
    }
    return l;
  }

  // Bookkeeping only: record that this client uses this tab. The physical
  // attach happens under the tab lock at the operation call site.
  function acquire(clientId, tabId) {
    leaseFor(clientId).add(tabId);
    log("info", "lease acquired", { clientId, tabId });
  }

  function hasTabLease(tabId) {
    return (
      [...clientLeases.values()].some((l) => l.has(tabId)) ||
      !!hasCaptureOnTab(tabId)
    );
  }

  async function release(clientId, tabId) {
    return withTabLock(tabId, clientId, async () => {
      const l = clientLeases.get(clientId);
      if (!l || !l.has(tabId)) return;
      l.delete(tabId);
      if (!l.size) clientLeases.delete(clientId);
      const stillLeased = hasTabLease(tabId);
      if (!stillLeased) await detach(tabId);
      log("info", "lease released", {
        clientId,
        tabId,
        detached: !stillLeased,
      });
    });
  }

  // Reject a command whose connection is gone / unauthenticated, or whose
  // deadline already passed. Called automatically by withTabLock.
  function beginCommand(ctx) {
    if (!ctx) return;
    if (
      ctx.ws?.__retired ||
      (ctx.authenticationRequired && !ctx.ws?.__authenticated)
    ) {
      throw new Error("command connection is no longer authenticated");
    }
    if (
      ctx.cancelled ||
      (ctx.deadlineAt != null && Date.now() >= ctx.deadlineAt)
    ) {
      throw new Error(
        ctx.cancelled
          ? "command cancelled before execution"
          : "command deadline expired before execution",
      );
    }
    ctx.started = true;
  }

  /**
   * Run a CDP command on a tab with exclusive, FIFO-serialized access.
   * Concurrent calls on the same tab queue up; different tabs run in parallel.
   *
   * `lockTimeoutMs` should be the operation's own CDP timeout plus headroom:
   * the lock must outlive the cdpSend it guards, otherwise the lock times out
   * while the CDP call is still legitimately in flight.
   */
  async function withTabLock(
    tabId,
    clientId,
    fn,
    lockTimeoutMs = defaultLockTimeoutMs,
    ctx,
  ) {
    const item = await tabLock.acquire(tabId, lockTimeoutMs);
    try {
      beginCommand(ctx);
      return await fn();
    } finally {
      tabLock.release(tabId, item);
    }
  }

  return {
    clientLeases,
    leaseFor,
    acquire,
    hasTabLease,
    release,
    beginCommand,
    withTabLock,
  };
}

const LeaseManager = { createLeaseManager };
if (typeof globalThis !== "undefined") Object.assign(globalThis, LeaseManager);
if (typeof module !== "undefined" && module.exports)
  module.exports = LeaseManager;
