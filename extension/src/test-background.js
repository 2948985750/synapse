#!/usr/bin/env node
"use strict";
// Browser-free test that loads the REAL background.js and drives its actual
// concurrency logic (withTabLock / clientLeases / attach de-dup / releaseLease)
// through a chrome.* mock.
//
// This is the gap the agent-gate test can't cover: that test's "fake extension"
// auto-replies and bypasses every real line in background.js. Here we run the
// real module with a mock chrome debugger that faithfully simulates the one
// hazard CDP has — `chrome.debugger.attach` on an already-attached tab THROWS.
// If the tab lock / ensureAttached de-dup were broken, two concurrent agents
// attaching one tab would make the 2nd attach throw. So the assertion
// "3 concurrent attaches on one tab => debugger.attach called exactly once,
// all replies ok:true" is a direct proof the race fix holds.
//
//   node extension/src/test-background.js

const path = require("path");
const fs = require("fs");
const assert = require("assert");
const vm = require("vm");

const tick = () => new Promise((r) => setImmediate(r));

// ---------------- chrome.debugger mock (faithful attach mutuality) --------
function makeDebugger() {
  const attached = new Map(); // tabId -> targetId
  const calls = new Map(); // tabId -> physical attach() call count
  let targetSeq = 0;
  const order = []; // CDP op ordering (for FIFO checks)
  const state = { attached, calls, order };

  const api = {
    async attach({ tabId }, _version) {
      // Simulate real CDP: attaching a tab that is ALREADY attached throws.
      if (attached.has(tabId)) {
        throw new Error(`Cannot attach to Tab ${tabId}: Already attached`);
      }
      await tick(); // let a concurrent, UN-LOCKED attach interleave and hit the throw
      calls.set(tabId, (calls.get(tabId) || 0) + 1);
      const targetId = `target-${++targetSeq}`;
      attached.set(tabId, targetId);
      return { targetId };
    },
    async detach({ tabId }) {
      attached.delete(tabId);
      await tick();
    },
    // Reflect the mock's attach state as a DebuggerTarget[] (MV3 promise form).
    async getTargets() {
      const out = [];
      for (const [tabId, targetId] of attached) out.push({ tabId, targetId, attached: true, type: "page" });
      return out;
    },
    async sendCommand(target, method, params) {
      // Emulation/Page/Runtime enable calls are fire-and-forget in the bg.
      if (method.startsWith("Emulation.") || method === "Page.enable" || method === "Runtime.enable") {
        return {};
      }
      if (method === "__slow") {
        await new Promise((r) => setTimeout(r, 200));
        order.push("slow");
        return { method };
      }
      if (method === "__fast") {
        order.push("fast");
        return { method };
      }
      if (method === "__hang") {
        // Never settles: exercises the cdpSend timeout race so a stuck CDP
        // command cannot wedge the tab lock.
        return new Promise(() => {});
      }
      if (method === "Runtime.evaluate") {
        // 按模板特征返回 canned 值。注意 click/type 共用同一 IIFE（含双分支），
        // 用尾参的 act 字面量（,"click", / ,"type",）区分；snapshot 有独有串。
        const expr = (params && params.expression) || "";
        let val;
        if (expr.indexOf("total:nodes.length") !== -1) {
          val = JSON.stringify({ url: "https://x/", ts: 1, total: 1, count: 1, items: [{ i: 0, tag: "input", role: "", label: "q" }] });
        } else if (expr.indexOf(',"click",') !== -1) {
          val = JSON.stringify({ found: true, clicked: "搜索", rect: [0, 0] });
        } else if (expr.indexOf(',"type",') !== -1) {
          val = JSON.stringify({ found: true, typed: "hi" });
        } else {
          return { result: { type: "undefined" } };
        }
        return { result: { type: "string", value: val } };
      }
      return { method, params };
    },
    onDetach: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    onEvent: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
  };
  return { api, state };
}

// ---------------- chrome.* mock factory ----------------------------------
function makeChrome(dbg) {
  const port = {
    onMessage: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    onDisconnect: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    posted: [],
    postMessage(obj) { this.posted.push(obj); },
  };
  const installed = [];
  const onMessage = [];
  const chrome = {
    runtime: {
      lastError: null,
      // Single dispatcher: chrome fires every registered onMessage listener for
      // each message, exactly like the real API. The mock records listeners and
      // dispatches to all of them so each listener sees (msg, sender, sendResponse).
      onMessage: {
        listeners: onMessage,
        addListener(fn) { onMessage.push(fn); },
        dispatch(msg) {
          const sendResponse = () => {};
          for (const fn of onMessage) fn(msg, { tab: { id: 1, url: "about:blank" } }, sendResponse);
        },
      },
      onInstalled: { addListener(fn) { installed.push(fn); } },
      commands: {
        onCommand: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
      },
    },
    debugger: dbg.api,
    tabs: {
      query: async () => [{ id: 1, url: "about:blank", title: "B", active: true }],
      create: async ({ url }) => ({ id: 777, url, status: "loading" }),
      get: async (tabId) => ({ id: tabId, status: "complete" }),
    },
    tabGroups: { create: async () => ({ id: 999 }) },
    sidePanel: { setPanelBehavior: async () => ({}) },
    storage: {
      local: {
        _d: {},
        get(_keys, cb) { cb && cb(this._d); },
        set(o, cb) { Object.assign(this._d, o); cb && cb(); },
      },
    },
  };
  return {
    chrome,
    port,
    fireInstalled() { installed.forEach((f) => f()); },
  };
}

// Load the real background.js once, with chrome + importScripts mocked.
function loadBackground(mock) {
  const bgPath = path.join(__dirname, "background.js");
  const tlPath = path.join(__dirname, "tablock.js");
  delete require.cache[require.resolve(bgPath)];
  global.chrome = mock.chrome;
  // Resolve the imported file relative to background.js's own directory, so
  // adding a second importScripts module later doesn't silently break the stub.
  global.importScripts = (...files) => {
    for (const file of files) {
      const target = path.resolve(__dirname, String(file).replace(/^\.\//, ""));
      if (!fs.existsSync(target)) throw new Error("importScripts: cannot resolve " + file);
      const mod = require(target);
      if (mod.TabLock) global.TabLock = mod.TabLock;
      if (mod.PROTOCOL) global.WSAuth = mod;
    }
  };
  const handle = require(bgPath);
  mock.fireInstalled(); // -> onInstalled (now dials the WS bridge; no-ops in node mock)
  // 生产里已没有 native messaging 通道；测试用 execAgentCmd 直接注入命令，
  // 由下面的 sendCmd 复现 agent.cmd / diag 的信封语义。
  mock.port.__handle = handle;
  mock.handle = handle; // expose the module handle (captureSessions, agentWs, execAgentCmd)
  return mock;
}

// ---------------- 命令注入（替代已删除的 native 通道） -------------------
// 复现旧通道的信封语义：agent.cmd → {type:"agent.result", ok, result|error}；
// diag → {type:"diag", ...payload}。生产端不再有 native port，测试直接调 execAgentCmd。
function sendCmd(port, msg) {
  const handle = port.__handle;
  const isDiag = msg.type === "diag";
  const cmd = isDiag ? "diag" : msg.cmd;
  const args = isDiag ? {} : msg.args;
  const client = (args && args.clientId) || "test";
  Promise.resolve()
    .then(() => handle.execAgentCmd(cmd, args, client))
    .then((result) => {
      port.posted.push(isDiag
        ? { type: "diag", id: msg.id, ...result }
        : { type: "agent.result", id: msg.id, ok: true, result });
    })
    .catch((e) => {
      port.posted.push({ type: "agent.result", id: msg.id, ok: false, error: String(e.message || e) });
    });
}

function waitForReply(port, id, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = port.posted.find((m) => m.type === type && m.id === id);
      if (hit) { clearInterval(iv); resolve(hit); }
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting ${type} id=${id}; posted=${JSON.stringify(port.posted.map((m) => m.type + ":" + m.id))}`));
      }
    }, 5);
  });
}

// ---------------- tests ---------------------------------------------------
let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log("  ok - " + name);
}

async function main() {
  console.log("background (real module, mocked chrome.debugger)");
  const dbg = makeDebugger();
  const mock = loadBackground(makeChrome(dbg));
  const { port } = mock;
  const handle = mock.handle;
  const state = dbg.state;

  // A. attach race: 3 concurrent agents attach ONE tab => physical attach once.
  await ok("3 concurrent agents attach same tab -> attach() exactly once, all ok", async () => {
    const jobs = ["c1", "c2", "c3"].map((c, i) => {
      const id = "attach-" + i;
      sendCmd(port, { type: "agent.cmd", id, cmd: "attach", args: { tabId: 100, clientId: c } });
      return waitForReply(port, id, "agent.result");
    });
    const replies = await Promise.all(jobs);
    assert.ok(replies.every((r) => r.ok === true), "all three attach replies ok");
    assert.strictEqual(state.calls.get(100), 1, "chrome.debugger.attach called once for tab 100");
    assert.ok(state.attached.has(100), "tab 100 ends attached");
  });

  // B. FIFO: on one tab, a slow op started first must fully run before a fast
  //    op that arrives second (serialization by the per-tab lock).
  await ok("same tab: slow op started first completes before later fast op (FIFO)", async () => {
    state.order.length = 0;
    sendCmd(port, { type: "agent.cmd", id: "f-slow", cmd: "cdp", args: { tabId: 200, method: "__slow", clientId: "c1" } });
    await new Promise((r) => setTimeout(r, 100)); // let slow acquire the lock & enter its 200ms sleep
    sendCmd(port, { type: "agent.cmd", id: "f-fast", cmd: "cdp", args: { tabId: 200, method: "__fast", clientId: "c2" } });
    await Promise.all([waitForReply(port, "f-slow", "agent.result"), waitForReply(port, "f-fast", "agent.result")]);
    assert.ok(state.order.indexOf("slow") < state.order.indexOf("fast"), "slow fully executed before fast (" + state.order + ")");
  });

  // C. cross-tab parallelism: two slow ops on DIFFERENT tabs run concurrently.
  await ok("different tabs: two 200ms ops run in parallel (not serialized)", async () => {
    const t0 = Date.now();
    sendCmd(port, { type: "agent.cmd", id: "p-a", cmd: "cdp", args: { tabId: 300, method: "__slow", clientId: "c1" } });
    sendCmd(port, { type: "agent.cmd", id: "p-b", cmd: "cdp", args: { tabId: 301, method: "__slow", clientId: "c2" } });
    await Promise.all([waitForReply(port, "p-a", "agent.result"), waitForReply(port, "p-b", "agent.result")]);
    const elapsed = Date.now() - t0;
    // serialized would be ~400ms; parallel ~210ms. Allow generous margin.
    assert.ok(elapsed < 390, "two tabs ran in parallel, elapsed=" + elapsed + "ms");
  });

  // D. clientId attribution: diag reports which client leases which tab.
  await ok("diag attributes tabs to the right client (clientId passthrough)", async () => {
    sendCmd(port, { type: "agent.cmd", id: "d-a", cmd: "attach", args: { tabId: 400, clientId: "alpha" } });
    sendCmd(port, { type: "agent.cmd", id: "d-b", cmd: "attach", args: { tabId: 401, clientId: "beta" } });
    await Promise.all([waitForReply(port, "d-a", "agent.result"), waitForReply(port, "d-b", "agent.result")]);
    sendCmd(port, { type: "diag", id: "d-d" });
    const d = await waitForReply(port, "d-d", "diag");
    const alpha = d.clients.find((c) => c.clientId === "alpha");
    const beta = d.clients.find((c) => c.clientId === "beta");
    assert.ok(alpha && alpha.tabs.includes(400), "alpha leases tab 400");
    assert.ok(beta && beta.tabs.includes(401), "beta leases tab 401");
  });

  // E. releaseLease physical detach timing: detach only when the LAST client
  //    on a tab releases. c1+c2 both lease tab 500; c1 detaches -> still
  //    attached; c2 detaches -> physically detached.
  await ok("physical detach only when the last client on a tab releases", async () => {
    sendCmd(port, { type: "agent.cmd", id: "e-a", cmd: "attach", args: { tabId: 500, clientId: "c1" } });
    sendCmd(port, { type: "agent.cmd", id: "e-b", cmd: "attach", args: { tabId: 500, clientId: "c2" } });
    await Promise.all([waitForReply(port, "e-a", "agent.result"), waitForReply(port, "e-b", "agent.result")]);
    assert.ok(state.attached.has(500), "tab 500 attached under two clients");

    sendCmd(port, { type: "agent.cmd", id: "e-c1", cmd: "detach", args: { tabId: 500, clientId: "c1" } });
    await waitForReply(port, "e-c1", "agent.result");
    assert.ok(state.attached.has(500), "c1 detached but c2 still holds -> tab stays attached");

    sendCmd(port, { type: "agent.cmd", id: "e-c2", cmd: "detach", args: { tabId: 500, clientId: "c2" } });
    await waitForReply(port, "e-c2", "agent.result");
    assert.ok(!state.attached.has(500), "last client detached -> physical detach fired");
  });

  // F. unknown agent cmd surfaces ok:false without crashing the dispatch.
  await ok("unknown agent.cmd returns ok:false and the worker stays healthy", async () => {
    sendCmd(port, { type: "agent.cmd", id: "u-1", cmd: "noSuchCmd", args: { clientId: "c1" } });
    const r = await waitForReply(port, "u-1", "agent.result");
    assert.strictEqual(r.ok, false, "unknown cmd -> ok:false");
    // worker still healthy: a real cmd afterwards still round-trips.
    sendCmd(port, { type: "agent.cmd", id: "u-2", cmd: "attach", args: { tabId: 600, clientId: "c1" } });
    const r2 = await waitForReply(port, "u-2", "agent.result");
    assert.strictEqual(r2.ok, true, "dispatch healthy after unknown cmd");
  });

  // G. a stuck CDP command must NOT wedge the tab: cdpSend races its own
  //    timeout, so after the timeout fires the tab lock is released and the
  //    next op on the SAME tab proceeds (proves the timeout-race fix).
  await ok("a hanging CDP command times out and frees the tab lock", async () => {
    sendCmd(port, { type: "agent.cmd", id: "h-hang", cmd: "cdp", args: { tabId: 700, method: "__hang", clientId: "c1", timeoutMs: 120 } });
    const r = await waitForReply(port, "h-hang", "agent.result", 3000);
    assert.strictEqual(r.ok, false, "hanging cdp surfaces as ok:false (CDP timeout)");
    // Now a normal op on the same tab must still get in (lock was released).
    sendCmd(port, { type: "agent.cmd", id: "h-fast", cmd: "cdp", args: { tabId: 700, method: "__fast", clientId: "c2", timeoutMs: 3000 } });
    const r2 = await waitForReply(port, "h-fast", "agent.result", 3000);
    assert.strictEqual(r2.ok, true, "tab lock freed after the hang");
  });
  // H. detach from a client that never leased the tab is a clean no-op.
  await ok("detach from an unknown client is a no-op (no detach, no throw)", async () => {
    sendCmd(port, { type: "agent.cmd", id: "n-a", cmd: "attach", args: { tabId: 800, clientId: "real" } });
    await waitForReply(port, "n-a", "agent.result");
    assert.ok(state.attached.has(800), "tab attached under 'real'");
    sendCmd(port, { type: "agent.cmd", id: "n-x", cmd: "detach", args: { tabId: 800, clientId: "stray" } });
    const rx = await waitForReply(port, "n-x", "agent.result");
    assert.strictEqual(rx.ok, true, "stray detach reported ok");
    assert.ok(state.attached.has(800), "stray detach did NOT physically detach the tab");
  });

  // I. capture: an active capture session routes matching CDP events to the
  //    subscribing agent's socket as {type:"event.push"}, filtered by domain;
  //    capture.stop clears the session.
  await ok("capture session forwards matching CDP events to the agent socket", async () => {
    // Ensure a WebSocket.OPEN constant exists in node (sendWs references it).
    if (typeof global.WebSocket === "undefined") {
      global.WebSocket = { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 };
    } else if (typeof global.WebSocket.OPEN !== "number") {
      global.WebSocket.OPEN = 1;
    }
    const sentFrames = [];
    const fakePort = 9999;
    const fakeSocket = {
      readyState: global.WebSocket.OPEN,
      send: (s) => sentFrames.push(s),
      close() {},
      terminate() {},
    };
    handle.agentWs.set(fakePort, new Set([fakeSocket]));
    // Open a capture session for tab 1 over this fake socket.
    const started = await handle.execAgentCmd(
      "capture.start",
      { tabId: 1, domains: ["Network"], durationMs: 60000 },
      "capc",
      { ws: fakeSocket, wsPort: fakePort }
    );
    assert.ok(started && started.started === true, "capture.start ok: " + JSON.stringify(started));
    assert.ok(handle.captureSessions.size === 1, "one capture session active");

    const fire = (method, params, source) =>
      dbg.api.onEvent.listeners[0](source || { tabId: 1 }, method, params);

    // Matching-domain event IS forwarded.
    fire("Network.requestWillBeSent", { requestId: "r1", request: { url: "https://x.com/a.json", method: "GET" }, type: "xhr" });
    let pushed = sentFrames.filter((s) => JSON.parse(s).type === "event.push");
    assert.strictEqual(pushed.length, 1, "Network event forwarded exactly once");
    const ev = JSON.parse(pushed[0]);
    assert.strictEqual(ev.method, "Network.requestWillBeSent");
    assert.strictEqual(ev.tabId, 1);
    assert.ok(ev.params.requestId === "r1", "params carried through");

    // A non-subscribed domain is NOT forwarded.
    fire("Runtime.consoleAPICalled", { type: "log", args: [] });
    pushed = sentFrames.filter((s) => JSON.parse(s).type === "event.push");
    assert.strictEqual(pushed.length, 1, "non-subscribed domain not forwarded");

    // Events for a different tab are NOT forwarded to this session.
    fire("Network.requestWillBeSent", { requestId: "r2", request: { url: "https://y.com/b" }, type: "xhr" }, { tabId: 777 });
    pushed = sentFrames.filter((s) => JSON.parse(s).type === "event.push");
    assert.strictEqual(pushed.length, 1, "other-tab event not forwarded");

    // capture.stop clears the session and stops forwarding.
    const stopRes = await handle.execAgentCmd("capture.stop", { tabId: 1 }, "capc", { ws: fakeSocket, wsPort: fakePort });
    assert.strictEqual(stopRes.stopped, true, "capture.stop reports stopped");
    assert.strictEqual(handle.captureSessions.size, 0, "session cleared");
    fire("Network.requestWillBeSent", { requestId: "r3", request: { url: "https://x.com/c" }, type: "xhr" });
    pushed = sentFrames.filter((s) => JSON.parse(s).type === "event.push");
    assert.strictEqual(pushed.length, 1, "no forwarding after stop");
    handle.agentWs.delete(fakePort);
  });

  // J. per-socket result routing: two concurrent sockets on the same port
  //    each get the reply to the cmd they sent, and only that reply.
  await ok("agent.result is routed back to the originating socket", async () => {
    if (typeof global.WebSocket === "undefined") {
      global.WebSocket = { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 };
    } else if (typeof global.WebSocket.OPEN !== "number") {
      global.WebSocket.OPEN = 1;
    }
    const framesA = [];
    const framesB = [];
    const mkSocket = (frames) => ({
      readyState: global.WebSocket.OPEN,
      __authenticated: true,
      send: (s) => frames.push(s),
      close() {},
      terminate() {},
    });
    const sockA = mkSocket(framesA);
    const sockB = mkSocket(framesB);
    const port = 9998;
    handle.agentWs.set(port, new Set([sockA, sockB]));

    // Drive both cmds through onWsMessage (where id + socket routing happens).
    handle.onWsMessage(sockA, port, JSON.stringify({ type: "cmd", id: "ja", cmd: "tabs", args: {}, clientId: "route-a" }));
    handle.onWsMessage(sockB, port, JSON.stringify({ type: "cmd", id: "jb", cmd: "tabs", args: {}, clientId: "route-b" }));
    await new Promise((r) => setTimeout(r, 80)); // let the execAgentCmd promise chains settle

    const resultA = framesA.filter((s) => JSON.parse(s).type === "agent.result");
    const resultB = framesB.filter((s) => JSON.parse(s).type === "agent.result");
    assert.strictEqual(resultA.length, 1, "socket A got exactly one result: " + JSON.stringify(framesA));
    assert.strictEqual(resultB.length, 1, "socket B got exactly one result: " + JSON.stringify(framesB));
    assert.strictEqual(JSON.parse(resultA[0]).id, "ja", "A's result carries A's id");
    assert.strictEqual(JSON.parse(resultB[0]).id, "jb", "B's result carries B's id");
    assert.strictEqual(JSON.parse(resultA[0]).ok, true, "result ok");
    handle.agentWs.delete(port);
  });

  // K. 索引化动作空间（jev 引入）：snapshot/click-el/type-el 命令分发 +
  //    模板语法自检 + 参数校验。mock 的 Runtime.evaluate 按模板特征返回 canned 值。
  await ok("indexed action space: snapshot/click-el/type-el dispatch + template syntax", async () => {
    // 1) 模板编译自检（模板串坏了在这里炸，到不了页面）
    const snapSrc = handle.snapshotExpr(5);
    const clickSrc = handle.actExpr({ i: 0, tag: "a", label: "搜索" }, "click", "");
    const typeSrc = handle.actExpr({ i: 1, tag: "input", label: "" }, "type", "__CLEAR__hi");
    for (const src of [snapSrc, clickSrc, typeSrc]) {
      new Function(src); // 仅语法编译；IIFE 作为函数体合法
    }
    assert.ok(snapSrc.indexOf("total:nodes.length") >= 0, "snapshot template walks the DOM");

    // 2) snapshot 分发：canned 索引被 JSON.parse 回对象
    const res = await handle.execAgentCmd("snapshot", { tabId: 1, max: 5 }, "snapper");
    assert.ok(res && Array.isArray(res.items) && res.items.length === 1, "snapshot returns parsed items: " + JSON.stringify(res));

    // 3) click-el：canned found 结果透传
    const cr = await handle.execAgentCmd("click-el", { tabId: 1, el: { i: 0, tag: "a", label: "搜索" } }, "snapper");
    assert.ok(cr && cr.found === true && cr.clicked === "搜索", "click-el returns found result: " + JSON.stringify(cr));

    // 4) type-el：canned typed 结果透传
    const tr = await handle.execAgentCmd("type-el", { tabId: 1, el: { i: 1, tag: "input", label: "" }, text: "hi", clear: true }, "snapper");
    assert.ok(tr && tr.found === true && tr.typed === "hi", "type-el returns typed result: " + JSON.stringify(tr));

    // 5) 参数校验：缺 el.i / 缺 text / 缺 tabId 都拒绝
    await assert.rejects(handle.execAgentCmd("click-el", { tabId: 1, el: { label: "x" } }, "snapper"), /click-el/);
    await assert.rejects(handle.execAgentCmd("type-el", { tabId: 1, el: { i: 0 } }, "snapper"), /type-el/);
    await assert.rejects(handle.execAgentCmd("snapshot", { max: 5 }, "snapper"), /tabId/);
  });

  await ok("duplicate capture starts are rejected inside the tab lock", async () => {
    const sock = { readyState: 1, send() {} };
    const ctx = { ws: sock, wsPort: 9999 };
    const results = await Promise.allSettled([
      handle.execAgentCmd("capture.start", { tabId: 901 }, "duplicate", ctx),
      handle.execAgentCmd("capture.start", { tabId: 901 }, "duplicate", ctx),
    ]);
    assert.strictEqual(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.strictEqual(results.filter((r) => r.status === "rejected").length, 1);
    const started = results.find((r) => r.status === "fulfilled").value;
    await handle.stopCapture(started.captureId);
    assert.ok(!state.attached.has(901), "capture-only lease is released on stop");
  });

  await ok("stopping one capture preserves the other capture's domain and lease", async () => {
    const sock = { readyState: 1, send() {} };
    const ctx = { ws: sock, wsPort: 9999 };
    const commands = [];
    const original = dbg.api.sendCommand;
    dbg.api.sendCommand = async (target, method, params) => { commands.push(method); return original(target, method, params); };
    try {
      const a = await handle.execAgentCmd("capture.start", { tabId: 902 }, "capture-a", ctx);
      const b = await handle.execAgentCmd("capture.start", { tabId: 902 }, "capture-b", ctx);
      assert.strictEqual(commands.filter((m) => m === "Network.enable").length, 1);
      commands.length = 0;
      await handle.stopCapture(a.captureId);
      assert.ok(handle.captureSessions.get(b.captureId).active);
      assert.ok(state.attached.has(902));
      assert.ok(!commands.includes("Network.disable"));
      await handle.stopCapture(b.captureId);
      assert.strictEqual(commands.filter((m) => m === "Network.disable").length, 1);
      assert.ok(!state.attached.has(902));
    } finally { dbg.api.sendCommand = original; }
  });

  await ok("capture lease survives explicit detach and stop preserves explicit leases", async () => {
    const ctx = { ws: { readyState: 1, send() {} }, wsPort: 9999 };
    await handle.execAgentCmd("attach", { tabId: 903 }, "explicit");
    const a = await handle.execAgentCmd("capture.start", { tabId: 903 }, "collector", ctx);
    await handle.execAgentCmd("detach", { tabId: 903 }, "explicit");
    assert.ok(state.attached.has(903), "live capture prevents detach");
    await handle.execAgentCmd("attach", { tabId: 903 }, "explicit");
    await handle.stopCapture(a.captureId);
    assert.ok(state.attached.has(903), "capture stop preserves unrelated lease");
    await handle.execAgentCmd("detach", { tabId: 903 }, "explicit");
    assert.ok(!state.attached.has(903));
  });

  await ok("failed domain enable rejects capture and rolls back enabled domains", async () => {
    const original = dbg.api.sendCommand;
    const commands = [];
    dbg.api.sendCommand = async (target, method, params) => {
      commands.push(method);
      if (method === "Fetch.enable") throw new Error("enable denied");
      return original(target, method, params);
    };
    try {
      await assert.rejects(handle.execAgentCmd("capture.start", { tabId: 904, domains: ["Network", "Fetch"] }, "failure", { ws: { readyState: 1, send() {} } }), /enable denied/);
      assert.ok(commands.includes("Network.disable"));
      assert.ok(![...handle.captureSessions.values()].some((s) => s.tabId === 904));
      assert.ok(!state.attached.has(904));
    } finally { dbg.api.sendCommand = original; }
  });

  await ok("capture stop enforces client and originating socket ownership", async () => {
    const sock = { readyState: 1, send() {} };
    const started = await handle.execAgentCmd("capture.start", { tabId: 905 }, "owner", { ws: sock });
    await assert.rejects(handle.execAgentCmd("capture.stop", { captureId: started.captureId }, "other", { ws: sock }), /another client/);
    await assert.rejects(handle.execAgentCmd("capture.stop", { captureId: started.captureId }, "owner", { ws: {} }), /another client/);
    await handle.execAgentCmd("capture.stop", { captureId: started.captureId }, "owner", { ws: sock });
  });

  await ok("snapshot long aria labels remain actionable and changed labels are rejected", async () => {
    let label = "abcdefghijklmnopqrstuvwxyz1234";
    let clicks = 0;
    const element = {
      tagName: "BUTTON", disabled: false,
      getAttribute(name) { return name === "aria-label" ? label : null; },
      getBoundingClientRect() { return { width: 20, height: 20, x: 0, y: 0 }; },
      click() { clicks++; },
    };
    const page = { document: { querySelectorAll() { return [element]; } }, location: { href: "https://example.invalid/" }, Date };
    const snapshot = JSON.parse(vm.runInNewContext(handle.snapshotExpr(5), page));
    const action = handle.actExpr(snapshot.items[0], "click", "");
    assert.strictEqual(JSON.parse(vm.runInNewContext(action, page)).found, true);
    assert.strictEqual(clicks, 1);
    label += "changed";
    assert.strictEqual(JSON.parse(vm.runInNewContext(action, page)).found, false);
    assert.strictEqual(clicks, 1);
  });

  await ok("content status has exactly one successful runtime responder", async () => {
    const responses = [];
    for (const listener of mock.chrome.runtime.onMessage.listeners) {
      listener({ type: "content.status" }, {}, (r) => responses.push(r));
    }
    await tick();
    assert.strictEqual(responses.length, 1);
    assert.strictEqual(responses[0].ok, true);
  });

  await ok("unauthenticated socket cannot execute commands or fake hello", async () => {
    let closed = 0;
    const sock = { readyState: 1, close() { closed++; }, send() { throw new Error("unexpected response"); } };
    await handle.onWsMessage(sock, 9999, JSON.stringify({ type: "cmd", id: "bad", cmd: "attach", args: { tabId: 906 }, clientId: "bad" }));
    assert.strictEqual(closed, 1);
    assert.ok(!state.attached.has(906));
    await handle.onWsMessage(sock, 9999, JSON.stringify({ type: "hello" }));
    assert.strictEqual(closed, 2);
  });

  await ok("extension always uses the built-in identifier and rejects a false server proof", async () => {
    // 鉴权标识是两侧内置常量：storage 里的值不再参与（配对 UI 已移除）。
    const token = WSAuth.DEFAULT_TOKEN;
    mock.chrome.storage.local._d.wbBridgeToken = "ab".repeat(32); // 应被忽略
    await handle.loadBridgeToken();
    const frames = [];
    const sock = { readyState: 1, close() { this.closed = true; }, send(raw) { frames.push(JSON.parse(raw)); } };
    const serverNonce = WSAuth.createNonce();
    await handle.onWsMessage(sock, 9999, JSON.stringify({ type: "auth.challenge", protocol: WSAuth.PROTOCOL, nonce: serverNonce }));
    const response = frames[0];
    assert.strictEqual(response.type, "auth.response");
    assert.ok(await WSAuth.verify(token, "extension", "client", serverNonce, response.nonce, response.proof));
    assert.ok(!JSON.stringify(response).includes(token));
    const proof = await WSAuth.sign(token, "extension", "server", serverNonce, response.nonce);
    await handle.onWsMessage(sock, 9999, JSON.stringify({ type: "auth.ok", protocol: WSAuth.PROTOCOL, proof }));
    assert.strictEqual(sock.__authenticated, true);
    const bad = { readyState: 1, close() { this.closed = true; }, send() {} };
    await handle.onWsMessage(bad, 9999, JSON.stringify({ type: "auth.challenge", protocol: WSAuth.PROTOCOL, nonce: WSAuth.createNonce() }));
    await handle.onWsMessage(bad, 9999, JSON.stringify({ type: "auth.ok", protocol: WSAuth.PROTOCOL, proof: "00".repeat(32) }));
    assert.strictEqual(bad.closed, true);
    assert.ok(!bad.__authenticated);
  });

  await ok("expired and cancelled queued commands perform no CDP action", async () => {
    const frames = [];
    const sock = { readyState: 1, __authenticated: true, send(raw) { frames.push(JSON.parse(raw)); } };
    const message = (id, method, deadlineAt) => JSON.stringify({ type: "cmd", id, cmd: "cdp", args: { tabId: 907, method }, clientId: "queue", deadlineAt });
    state.order.length = 0;
    const slow = handle.onWsMessage(sock, 9999, message("slow-q", "__slow", Date.now() + 5000));
    await new Promise((r) => setTimeout(r, 20));
    const expired = handle.onWsMessage(sock, 9999, message("expired-q", "__fast", Date.now() + 40));
    const cancelled = handle.onWsMessage(sock, 9999, message("cancel-q", "__fast", Date.now() + 5000));
    await tick();
    await handle.onWsMessage(sock, 9999, JSON.stringify({ type: "cancel", id: "cancel-q" }));
    await Promise.all([slow, expired, cancelled]);
    assert.deepStrictEqual(state.order, ["slow"]);
    assert.strictEqual(frames.find((r) => r.id === "expired-q").ok, false);
    assert.strictEqual(frames.find((r) => r.id === "cancel-q").ok, false);
    await handle.disconnectClient(sock, "queue", true);
    assert.ok(!state.attached.has(907));
  });

  await ok("client disconnect cleans only its captures and requested leases", async () => {
    const frames = [];
    const sock = { readyState: 1, __authenticated: true, send(raw) { frames.push(JSON.parse(raw)); } };
    const send = (id, cmd, args, clientId) => handle.onWsMessage(sock, 9999, JSON.stringify({ type: "cmd", id, cmd, args, clientId }));
    await send("client-a-attach", "attach", { tabId: 908 }, "a-clean");
    await send("client-b-attach", "attach", { tabId: 908 }, "b-clean");
    await send("client-a-cap", "capture.start", { tabId: 908 }, "a-clean");
    await handle.onWsMessage(sock, 9999, JSON.stringify({ type: "client.disconnect", id: "cleanup-a", clientId: "a-clean", releaseLeases: true }));
    assert.ok(![...handle.captureSessions.values()].some((s) => s.clientId === "a-clean"));
    assert.ok(state.attached.has(908), "other client's lease survives");
    assert.strictEqual(frames.find((r) => r.id === "cleanup-a").ok, true);
    await handle.disconnectClient(sock, "b-clean", false);
    assert.ok(state.attached.has(908), "stable explicit lease persists when requested");
    await handle.execAgentCmd("detach", { tabId: 908 }, "b-clean");
    assert.ok(!state.attached.has(908));
  });

  await ok("the same client cannot affect leases through a different live socket", async () => {
    const repliesA = [], repliesB = [];
    const a = { readyState: 1, __authenticated: true, send(raw) { repliesA.push(JSON.parse(raw)); } };
    const b = { readyState: 1, __authenticated: true, send(raw) { repliesB.push(JSON.parse(raw)); } };
    const msg = (id, cmd) => JSON.stringify({ type: "cmd", id, cmd, args: { tabId: 909 }, clientId: "cross-socket" });
    await handle.onWsMessage(a, 9991, msg("owner", "attach"));
    await handle.onWsMessage(b, 9992, msg("intruder", "detach"));
    assert.strictEqual(repliesB[0].ok, false);
    assert.match(repliesB[0].error, /another connection/);
    assert.ok(state.attached.has(909));
    await handle.disconnectClient(b, "cross-socket", true);
    assert.ok(state.attached.has(909), "foreign disconnect cannot release owner's lease");
    await handle.disconnectClient(a, "cross-socket", true);
    assert.ok(!state.attached.has(909));
  });

  await ok("new same-client work waits for old cleanup and keeps its new lease", async () => {
    const replies = [];
    const sock = { readyState: 1, __authenticated: true, send(raw) { replies.push(JSON.parse(raw)); } };
    const send = (id, cmd, args) => handle.onWsMessage(sock, 9991, JSON.stringify({ type: "cmd", id, cmd, args, clientId: "reused" }));
    const running = send("old", "cdp", { tabId: 910, method: "__slow" });
    await new Promise((r) => setTimeout(r, 20));
    const cleanup = handle.disconnectClient(sock, "reused", true);
    const next = send("new", "attach", { tabId: 910 });
    await Promise.all([running, cleanup, next]);
    assert.strictEqual(replies.find((r) => r.id === "new").ok, true);
    assert.ok(state.attached.has(910), "old cleanup did not detach new operation");
    await handle.disconnectClient(sock, "reused", true);
    assert.ok(!state.attached.has(910));
  });

  await ok("unpaired worker falls back to default key; auth.ok and immediate command cannot race", async () => {
    const originalWebSocket = global.WebSocket;
    const sockets = [];
    class MockSocket {
      static OPEN = 1;
      constructor(url) { this.url = url; this.readyState = 1; this.frames = []; sockets.push(this); }
      send(raw) { this.frames.push(JSON.parse(raw)); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    global.WebSocket = MockSocket;
    try {
      delete mock.chrome.storage.local._d.wbBridgeToken;
      await handle.loadBridgeToken();
      await handle.connectAgentWs();
      assert.strictEqual(sockets.length, 20, "unpaired worker dials with the default key");
      // 鉴权标识是内置常量：storage 里有值也不参与。
      const token = WSAuth.DEFAULT_TOKEN;
      mock.chrome.storage.local._d.wbBridgeToken = "cd".repeat(32); // 应被忽略
      await handle.loadBridgeToken();
      await handle.connectAgentWs();
      assert.strictEqual(sockets.length, 20);
      const sock = sockets[0];
      sock.onopen();
      const serverNonce = WSAuth.createNonce();
      sock.onmessage({ data: JSON.stringify({ type: "auth.challenge", protocol: WSAuth.PROTOCOL, nonce: serverNonce }) });
      await sock.__incoming;
      const response = sock.frames.find((f) => f.type === "auth.response");
      const proof = await WSAuth.sign(token, "extension", "server", serverNonce, response.nonce);
      sock.onmessage({ data: JSON.stringify({ type: "auth.ok", protocol: WSAuth.PROTOCOL, proof }) });
      sock.onmessage({ data: JSON.stringify({ type: "cmd", id: "immediate", cmd: "attach", args: { tabId: 911 }, clientId: "immediate-client" }) });
      await sock.__incoming;
      await Promise.allSettled([...sock.__requests.values()].map((r) => r.completion));
      assert.strictEqual(sock.frames.find((f) => f.id === "immediate").ok, true);
      assert.strictEqual(sock.__authenticated, true);
      await handle.disconnectClient(sock, "immediate-client", true);
      assert.ok(!state.attached.has(911));
    } finally {
      for (const sock of sockets) sock.close();
      global.WebSocket = originalWebSocket;
    }
  });

  // T-30 修复回归：open 默认等 load（mock tabs.get 恒返 complete → loaded:true）。
  await ok("open waits for tab load and reports loaded flag", async () => {
    const r = await handle.execAgentCmd("open", { url: "https://x/" }, "opener");
    assert.strictEqual(r.opened, true);
    assert.strictEqual(r.loaded, true);
    assert.strictEqual(r.tabId, 777);
  });

  // T-30 修复回归：snapshot/act 收集器递归 open shadowRoot，shadow 内控件可枚举可点。
  await ok("snapshot and click-el pierce open shadow roots", () => {
    let clicks = 0;
    const btn = {
      tagName: "BUTTON", disabled: false, innerText: "Shadow Button",
      getAttribute() { return null; },
      getBoundingClientRect() { return { width: 10, height: 10, x: 0, y: 0 }; },
      click() { clicks++; },
    };
    const shadow = { querySelectorAll: (sel) => (sel === "*" ? [] : [btn]) };
    const host = {
      tagName: "DIV", disabled: false, shadowRoot: shadow,
      getAttribute() { return null; },
      getBoundingClientRect() { return { width: 10, height: 10, x: 0, y: 0 }; },
    };
    const page = {
      document: { querySelectorAll: (sel) => (sel === "*" ? [host] : []) },
      location: { href: "https://shadow.invalid/" },
      Date,
    };
    const snapshot = JSON.parse(vm.runInNewContext(handle.snapshotExpr(5), page));
    assert.strictEqual(snapshot.total, 1, "shadow control enumerated");
    assert.strictEqual(snapshot.items[0].label, "Shadow Button");
    const action = handle.actExpr(snapshot.items[0], "click", "");
    assert.strictEqual(JSON.parse(vm.runInNewContext(action, page)).found, true);
    assert.strictEqual(clicks, 1);
  });

  console.log("\nALL-BACKGROUND-OK (" + passed + " cases)");
  process.exit(0);
}

main().catch((e) => {
  console.error("BACKGROUND-FAIL: " + (e.stack || e.message));
  process.exit(1);
});
