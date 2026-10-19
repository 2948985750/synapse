"use strict";
// FIFO per-key async mutex — serializes CDP operations on one browser tab.
//
// Pure module (no chrome.* APIs) so it is unit-testable without a browser.
// Loaded two ways:
//   - CommonJS (tests):   const { TabLock } = require("./tablock.js");
//   - Service worker:      importScripts("./tablock.js") -> global TabLock
// The UMD wrapper supports both without duplicating the class.
//
// Usage:
//   const lock = new TabLock();
//   await lock.acquire(tabId, 30000);
//   try { ...exclusive CDP work on this tab... } finally { lock.release(tabId); }
//
// Model: the queue head is the current holder. A new acquire that finds an
// empty queue becomes the holder immediately; otherwise it enqueues behind
// the holder and waits until the holder calls release().
//   - Per key, grants are FIFO.
//   - Different keys are independent (parallel across tabs).
//   - A waiter can time out and drop itself; if it WAS the holder it hands
//     off to the next waiter automatically.

(function (global, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = mod; // CommonJS (Node tests)
  }
  global.TabLock = mod.TabLock; // service worker / browser global
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  class TabLock {
    constructor() {
      this.queues = new Map(); // key -> [holder, waiter1, waiter2, ...]
    }

    _q(key) {
      let q = this.queues.get(key);
      if (!q) {
        q = [];
        this.queues.set(key, q);
      }
      return q;
    }

    /** Wait for exclusive access to `key`. Resolves when granted; rejects on timeout. */
    acquire(key, timeoutMs = 30000) {
      const q = this._q(key);
      const item = { settled: false, timer: null, resolve: null, reject: null };
      q.push(item);
      const p = new Promise((resolve, reject) => {
        item.resolve = resolve;
        item.reject = reject;
      });
      if (q.length === 1) this._grant(item); // just became the holder
      if (timeoutMs > 0) {
        item.timer = setTimeout(() => {
          if (item.settled) return;
          item.settled = true;
          const i = q.indexOf(item);
          if (i >= 0) q.splice(i, 1);
          if (i === 0) this._makeWay(key); // it was the holder; hand off
          item.reject(new Error("TabLock.acquire(" + key + ") timed out after " + timeoutMs + "ms"));
        }, timeoutMs);
      }
      return p;
    }

    /**
     * Hand exclusive access to the next waiter. Call from the holder's finally.
     *
     * Prefer `release(key, myItem)` — the item returned to the acquire caller —
     * so we settle exactly the entry we were holding. Blind `q.shift()` is
     * wrong after a holder-timeout splice: the head would be the NEXT waiter,
     * and settling it clears its timeout, turning a N ms waiter into a never
     * timing-out one. Bare `release(key)` is kept for callers that track no
     * item; it is only correct while the caller IS the current head.
     */
    release(key, myItem) {
      const q = this._q(key);
      if (q.length === 0) return;
      if (myItem) {
        const i = q.indexOf(myItem);
        if (i === -1) return; // already settled (timed out) or foreign item
        q.splice(i, 1);
        myItem.settled = true;
        if (myItem.timer) clearTimeout(myItem.timer);
        if (i === 0) this._makeWay(key); // was the holder; hand off
        return;
      }
      const holder = q.shift();
      if (holder) {
        holder.settled = true;
        if (holder.timer) clearTimeout(holder.timer);
      }
      this._makeWay(key);
    }

    _makeWay(key) {
      const q = this._q(key);
      if (q.length === 0) return;
      const next = q[0];
      if (!next.settled) this._grant(next);
    }

    _grant(item) {
      item.settled = true;
      if (item.timer) clearTimeout(item.timer);
      item.resolve();
    }

    /** Queue depth for `key` (holder + waiters). */
    size(key) {
      const q = this.queues.get(key);
      return q ? q.length : 0;
    }

    /** Keys currently holding an entry (waiters or in-flight). For diagnostics. */
    keys() {
      return [...this.queues.keys()];
    }
  }

  return { TabLock };
});
