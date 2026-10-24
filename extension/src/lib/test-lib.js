#!/usr/bin/env node
"use strict";
// Standalone tests for the three lib modules: no background.js, just mocks.
//   node extension/src/lib/test-lib.js
const assert = require("assert");
const vm = require("vm");
const path = require("path");

const { snapshotExpr, actExpr } = require("./page-actions.js");
const { createCdpTransport } = require("./cdp-transport.js");
const { createCaptureStore } = require("./capture-store.js");

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    console.log("  not ok - " + name);
    throw e;
  }
}

// ---------------- page-actions ----------------
function fakePage() {
  return {
    location: { href: "https://x/" },
    JSON,
    Date,
    window: { HTMLInputElement: { prototype: {} }, HTMLTextAreaElement: { prototype: {} } },
    document: {
      querySelectorAll(sel) {
        if (sel === "*") return [];
        if (String(sel).indexOf("input") === 0) return [inputEl];
        return [];
      },
    },
  };
}
const inputEl = {
  tagName: "INPUT",
  disabled: false,
  value: "",
  getAttribute(n) {
    return n === "placeholder" ? "q" : n === "role" ? "" : null;
  },
  getBoundingClientRect() {
    return { width: 100, height: 20, x: 1, y: 2 };
  },
  click() {
    this.clicked = true;
  },
  dispatchEvent() {},
  innerText: "",
  textContent: "",
};

async function main() {
  console.log("lib (page-actions / cdp-transport / capture-store)");

  // ---------------- page-actions ----------------
  await ok("snapshotExpr enumerates index, tag and label", () => {
    const page = fakePage();
    page.__elNodes = null;
    const out = JSON.parse(vm.runInNewContext(snapshotExpr(5), page));
    assert.strictEqual(out.count, 1);
    assert.strictEqual(out.items[0].i, 0);
    assert.strictEqual(out.items[0].tag, "input");
    assert.strictEqual(out.items[0].label, "q");
  });

  await ok("actExpr clicks the element at the given index", () => {
    const page = fakePage();
    const r = JSON.parse(vm.runInNewContext(actExpr({ i: 0 }, "click", ""), page));
    assert.strictEqual(r.found, true);
    assert.strictEqual(inputEl.clicked, true);
  });

  await ok("actExpr refuses an out-of-range index and a drifted label", () => {
    const p1 = fakePage();
    const r1 = JSON.parse(vm.runInNewContext(actExpr({ i: 9 }, "click", ""), p1));
    assert.strictEqual(r1.found, false);
    assert.match(r1.reason, /out of range/);
    const p2 = fakePage();
    const r2 = JSON.parse(vm.runInNewContext(actExpr({ i: 0, label: "other" }, "click", ""), p2));
    assert.strictEqual(r2.found, false);
    assert.match(r2.reason, /label drift/);
  });

  // ---------------- cdp-transport ----------------
  const makeChrome = (impl) => ({ debugger: { sendCommand: impl }, tabs: { get: async () => ({ status: "complete" }) } });

  await ok("send raises CDP timeout and clears the timer", async () => {
    const t = createCdpTransport({
      chromeApi: makeChrome(() => new Promise(() => {})),
      log: () => {},
      defaultTimeoutMs: 30,
    });
    await assert.rejects(() => t.sendOnce({ tabId: 1 }, "Runtime.evaluate", {}, 30), /CDP timeout/);
    await assert.rejects(() => t.send({ tabId: 1 }, "Page.navigate", {}, 30), /CDP timeout/);
  });

  await ok("Runtime.evaluate timeout retries once as a dialog (2 calls)", async () => {
    let calls = 0;
    const t = createCdpTransport({
      chromeApi: makeChrome(async () => {
        calls++;
        return new Promise(() => {});
      }),
      log: () => {},
      dialogRetryWaitMs: 5,
    });
    await assert.rejects(() => t.send({ tabId: 1 }, "Runtime.evaluate", {}, 20), /dialog|timeout/);
    assert.strictEqual(calls, 2);
  });

  await ok("lockMsForCdp covers the worst-case retry path", () => {
    const t = createCdpTransport({ chromeApi: makeChrome(async () => ({})), log: () => {} });
    const ev = t.lockMsForCdp(15000, "Runtime.evaluate");
    const other = t.lockMsForCdp(15000, "Page.navigate");
    assert.ok(ev > other, "the evaluate lock must outlast a plain command");
    assert.ok(ev >= 2 * 15000 + 5000, "covers 2×timeout plus the retry wait");
  });

  await ok("waitTabComplete returns loaded on complete and skips when waitMs<=0", async () => {
    const t = createCdpTransport({ chromeApi: makeChrome(async () => ({})), log: () => {} });
    assert.deepStrictEqual(await t.waitTabComplete(1, 0), { loaded: false, waitMs: 0 });
    const r = await t.waitTabComplete(1, 1000);
    assert.strictEqual(r.loaded, true);
  });

  // ---------------- capture-store ----------------
  const makeDeps = (over) => {
    const log = [];
    const detached = [];
    const disabled = [];
    return {
      log: (level, msg) => log.push(msg),
      cdpSend: async (_t, method) => {
        if (method.endsWith(".disable")) disabled.push(method);
        return {};
      },
      withTabLock: (_tab, _cid, fn) => fn(),
      ensureAttached: async () => ({ attached: true, targetId: "t1" }),
      doDetach: async (tabId) => detached.push(tabId),
      hasTabLease: () => true,
      getAttachedState: () => ({ attached: true, targetId: "t1" }),
      ...over,
      _log: log,
      _detached: detached,
      _disabled: disabled,
    };
  };

  await ok("start returns a captureId and registers the session", async () => {
    const deps = makeDeps();
    const store = createCaptureStore(deps);
    const r = await store.start({ tabId: 1, domains: ["Network"], durationMs: 1000 }, "c1", { ws: { readyState: 1 } });
    assert.strictEqual(r.started, true);
    assert.strictEqual(store.size(), 1);
    assert.strictEqual(store.sessions.get(r.captureId).tabId, 1);
  });

  await ok("a second start for the same tab+client is rejected", async () => {
    const deps = makeDeps();
    const store = createCaptureStore(deps);
    const ctx = { ws: { readyState: 1 } };
    await store.start({ tabId: 1, durationMs: 1000 }, "c1", ctx);
    await assert.rejects(() => store.start({ tabId: 1, durationMs: 1000 }, "c1", ctx), /already active/);
  });

  await ok("start without a WS context is rejected (WS-only channel)", async () => {
    const store = createCaptureStore(makeDeps());
    await assert.rejects(() => store.start({ tabId: 1 }, "c1", {}), /WS channel only/);
  });

  await ok("stop disables a domain no other capture still uses", async () => {
    const deps = makeDeps();
    const store = createCaptureStore(deps);
    const r = await store.start({ tabId: 1, domains: ["Network"], durationMs: 1000 }, "c1", { ws: { readyState: 1 } });
    await store.stop(r.captureId);
    assert.ok(deps._disabled.includes("Network.disable"));
    assert.strictEqual(store.size(), 0);
  });

  await ok("two captures sharing Network on one tab: the first stop does not disable", async () => {
    const deps = makeDeps();
    const store = createCaptureStore(deps);
    const ctx = { ws: { readyState: 1 } };
    const a = await store.start({ tabId: 1, domains: ["Network"], durationMs: 1000 }, "c1", ctx);
    const b = await store.start({ tabId: 1, domains: ["Network"], durationMs: 1000 }, "c2", ctx);
    await store.stop(a.captureId);
    assert.deepStrictEqual(deps._disabled, [], "another capture still uses Network on this tab");
    await store.stop(b.captureId);
    assert.deepStrictEqual(deps._disabled, ["Network.disable"]);
  });

  await ok("pushEvent only reaches the owner and only while readyState=1", async () => {
    const sent = [];
    const deps = makeDeps();
    const store = createCaptureStore(deps);
    const ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    const r = await store.start({ tabId: 7, domains: ["Network"], durationMs: 1000 }, "c1", { ws });
    store.pushEvent(7, "Network.loadingFinished", { requestId: "r1" });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, "event.push");
    assert.strictEqual(sent[0].captureId, r.captureId);
    store.pushEvent(7, "Page.frameNavigated", {});
    assert.strictEqual(sent.length, 1, "events outside the subscribed domains are not pushed");
    ws.readyState = 3;
    store.pushEvent(7, "Network.loadingFinished", { requestId: "r2" });
    assert.strictEqual(sent.length, 1, "nothing is pushed once the socket closed");
  });

  console.log("ALL-LIB-OK (" + passed + " cases)");
}

main().catch((e) => {
  console.error("LIB-FAIL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
