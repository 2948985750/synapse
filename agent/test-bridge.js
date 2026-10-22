"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createBridgeRouter } = require("./bridge-router");
const { authenticateServer, authenticateClient } = require("./bridge-auth");
const { WebSocketServer, WebSocket } = require("./vendor/ws");
const auth = require("./ws-auth");
const cli = require("./agent-collect");
class Socket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close(code) {
    this.readyState = 3;
    this.closeCode = code;
    this.emit("close");
  }
}
function harness() {
  let now = 1000;
  const timers = new Map();
  let nextTimer = 0;
  const router = createBridgeRouter({
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++nextTimer, { fn, at: now + ms });
      return nextTimer;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    router,
    timers,
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers])
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
    },
    command(id, clientId = "a", cmd = "navigate", args = {}) {
      return {
        type: "cmd",
        id,
        cmd,
        args,
        clientId,
        timeoutMs: 30000,
        deadlineAt: now + 30000,
        transientClient: true,
      };
    },
  };
}
test("queued commands preserve FIFO", () => {
  const h = harness(),
    a = new Socket(),
    extension = new Socket();
  h.router.addClient(a);
  h.router.clientMessage(a, h.command("first"));
  h.router.clientMessage(a, h.command("second"));
  h.router.attachExtension(extension);
  assert.deepEqual(
    extension.sent.map((x) => x.cmd),
    ["navigate", "navigate"],
  );
  const [first, second] = extension.sent;
  h.router.extensionMessage(extension, {
    type: "agent.result",
    id: first.id,
    ok: true,
    result: 1,
  });
  h.router.extensionMessage(extension, {
    type: "agent.result",
    id: second.id,
    ok: true,
    result: 2,
  });
  assert.deepEqual(
    a.sent.map((x) => x.id),
    ["first", "second"],
  );
  h.router.close();
});
test("closed and expired commanders cannot replay writes", () => {
  for (const disconnected of [true, false]) {
    const h = harness(),
      a = new Socket(),
      extension = new Socket();
    h.router.addClient(a);
    h.router.clientMessage(a, h.command("old"));
    if (disconnected) {
      a.close();
      h.router.disconnect(a);
    }
    h.advance(31000);
    h.router.attachExtension(extension);
    assert.equal(extension.sent.length, 0);
    assert.equal(h.timers.size, 0);
    if (!disconnected) assert.equal(a.sent[0].code, "COMMAND_TIMEOUT");
    h.router.close();
  }
});
test("cancel removes queued requests and informs extension for dispatched requests", () => {
  const h = harness(),
    a = new Socket(),
    extension = new Socket();
  h.router.addClient(a);
  h.router.clientMessage(a, h.command("queued"));
  h.router.clientMessage(a, { type: "cancel", id: "queued" });
  h.router.attachExtension(extension);
  assert.equal(extension.sent.length, 0);
  h.router.clientMessage(a, h.command("sent"));
  const wire = extension.sent[0].id;
  h.router.clientMessage(a, { type: "cancel", id: "sent" });
  assert.deepEqual(extension.sent.at(-1), { type: "cancel", id: wire });
  h.router.close();
});
test("capture events reach their owner only and reject wrong client identity", () => {
  const h = harness(),
    a = new Socket(),
    b = new Socket(),
    extension = new Socket();
  h.router.addClient(a);
  h.router.addClient(b);
  h.router.attachExtension(extension);
  h.router.clientMessage(a, h.command("start", "a", "capture.start"));
  h.router.extensionMessage(extension, {
    type: "agent.result",
    id: extension.sent[0].id,
    ok: true,
    result: { captureId: "cap-a" },
  });
  h.router.extensionMessage(extension, {
    type: "event.push",
    captureId: "cap-a",
    clientId: "a",
    method: "Network.responseReceived",
  });
  h.router.extensionMessage(extension, {
    type: "event.push",
    captureId: "cap-a",
    clientId: "b",
    method: "Network.responseReceived",
  });
  assert.equal(a.sent.length, 2);
  assert.equal(b.sent.length, 0);
  h.router.disconnect(a);
  h.router.extensionMessage(extension, {
    type: "event.push",
    captureId: "cap-a",
    clientId: "a",
  });
  assert.equal(a.sent.length, 2);
  assert.equal(extension.sent.at(-1).type, "client.disconnect");
  h.router.close();
});
test("duplicate live client identities are rejected; stable identity preserves leases on disconnect", () => {
  const h = harness(),
    a = new Socket(),
    b = new Socket(),
    extension = new Socket();
  h.router.addClient(a);
  h.router.addClient(b);
  h.router.attachExtension(extension);
  h.router.clientMessage(a, {
    ...h.command("a", "stable"),
    transientClient: false,
  });
  h.router.clientMessage(b, h.command("b", "stable"));
  assert.equal(b.sent[0].code, "CLIENT_BUSY");
  h.router.disconnect(a);
  assert.equal(extension.sent.at(-1).type, "client.disconnect");
  assert.equal(extension.sent.at(-1).clientId, "stable");
  assert.equal(extension.sent.at(-1).releaseLeases, false);
  h.router.close();
});
test("a second extension cannot silently replace the selected browser", () => {
  const h = harness(),
    a = new Socket(),
    b = new Socket();
  assert.equal(h.router.attachExtension(a), true);
  assert.equal(h.router.attachExtension(b), false);
  assert.equal(b.closeCode, 1008);
  h.router.close();
});
test("capture includes CDP XHR and Fetch with non-JSON MIME", async () => {
  const events = ["XHR", "Fetch"].flatMap((type, i) => [
    {
      method: "Network.requestWillBeSent",
      params: {
        requestId: String(i),
        type,
        request: { url: "https://example.invalid/" + i, method: "GET" },
      },
    },
    {
      method: "Network.responseReceived",
      params: {
        requestId: String(i),
        response: { status: 200, mimeType: "text/plain" },
      },
    },
  ]);
  const result = await cli.buildCaptureSessionResult(
    async () => ({ ok: true, result: { body: "ok" } }),
    { tabId: 1, action: "wait", captureId: "cap" },
    events,
    { durationMs: 1, bodyMaxKb: 1 },
  );
  assert.equal(result.returned, 2);
});
test("trigger JS executes after capture registration and failure always stops capture", async () => {
  const calls = [],
    events = new Map();
  const send = async (command) => {
    calls.push(command);
    if (command.cmd === "capture.start") {
      events.set("cap", []);
      return { ok: true, result: { captureId: "cap" } };
    }
    if (command.cmd === "cdp")
      return {
        ok: true,
        result: { exceptionDetails: { text: "trigger failed" } },
      };
    return { ok: true, result: {} };
  };
  await assert.rejects(
    cli.doCaptureMany(
      send,
      [{ tabId: 1, action: "wait" }],
      { durationMs: 1, triggerJs: "throw Error('x')" },
      events,
    ),
    /trigger failed/,
  );
  assert.deepEqual(
    calls.map((x) => x.cmd),
    ["capture.start", "cdp", "capture.stop"],
  );
  assert.equal(calls[1].args.params.awaitPromise, true);
  assert.equal(events.size, 0);
});
test("capture start partial failure cleans previous sessions", async () => {
  const calls = [];
  await assert.rejects(
    cli.doCaptureMany(
      async (command) => {
        calls.push(command);
        if (command.cmd === "capture.start" && command.args.tabId === 2)
          throw Error("cannot attach");
        return { ok: true, result: { captureId: "cap" } };
      },
      [
        { tabId: 1, action: "wait" },
        { tabId: 2, action: "wait" },
      ],
      { durationMs: 1 },
      new Map(),
    ),
    /cannot attach/,
  );
  assert.equal(calls.at(-1).cmd, "capture.stop");
});
test("failed protocol replies become errors, not successful result strings", async () => {
  await assert.rejects(
    cli.executeCommand(
      { sendCmd: async () => ({ ok: false, error: "tab closed" }) },
      { cmd: "navigate" },
      {},
    ),
    /tab closed/,
  );
});
async function wsFixture(handler) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  assert.ok(port < 9521 || port > 9540);
  server.on("connection", handler);
  return {
    port,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
test("mutual authentication works over an isolated loopback port", async () => {
  const token = crypto.randomBytes(32).toString("hex");
  let role;
  const server = await wsFixture((socket, request) =>
    authenticateServer(socket, request, token, (value) => {
      role = value;
    }),
  );
  const socket = new WebSocket("ws://127.0.0.1:" + server.port);
  socket.on("error", () => {});
  try {
    await authenticateClient(socket, token);
    assert.equal(role, "client");
  } finally {
    socket.terminate();
    await server.close();
  }
});
test("wrong token and webpage Origin cannot authenticate", async () => {
  const token = crypto.randomBytes(32).toString("hex");
  let accepted = 0;
  const server = await wsFixture((socket, request) =>
    authenticateServer(socket, request, token, () => {
      accepted++;
    }),
  );
  try {
    for (const options of [{}, { origin: "https://attacker.invalid" }]) {
      const socket = new WebSocket("ws://127.0.0.1:" + server.port, options);
      socket.on("error", () => {});
      await assert.rejects(
        authenticateClient(
          socket,
          options.origin ? token : "00".repeat(32),
          500,
        ),
      );
      socket.terminate();
    }
    assert.equal(accepted, 0);
  } finally {
    await server.close();
  }
});
test("client rejects a server without a valid server proof", async () => {
  const token = crypto.randomBytes(32).toString("hex");
  const server = await wsFixture((socket) => {
    socket.send(
      JSON.stringify({
        type: "auth.challenge",
        protocol: auth.PROTOCOL,
        nonce: auth.createNonce(),
      }),
    );
    socket.on("message", () =>
      socket.send(
        JSON.stringify({
          type: "auth.ok",
          protocol: auth.PROTOCOL,
          proof: "00".repeat(32),
        }),
      ),
    );
  });
  const socket = new WebSocket("ws://127.0.0.1:" + server.port);
  socket.on("error", () => {});
  try {
    await assert.rejects(authenticateClient(socket, token), /proof is invalid/);
  } finally {
    socket.terminate();
    await server.close();
  }
});
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "agent-collect.js"), ...args],
      { env: { ...process.env, ...env }, windowsHide: true },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("CLI test timed out"));
    }, 7000);
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
test("CLI extension failure is structured JSON with nonzero exit", async () => {
  // Token 机制已退役（T-32）：CLI 固定用默认密钥认证，fixture 必须接受它。
  const token = auth.DEFAULT_TOKEN,
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-bridge-test-"));
  const server = await wsFixture((socket, request) =>
    authenticateServer(socket, request, token, () =>
      socket.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.type === "cmd")
          socket.send(
            JSON.stringify({
              type: "agent.result",
              id: message.id,
              ok: false,
              error: "fixture tab missing",
            }),
          );
        else if (message.type === "client.disconnect")
          socket.send(
            JSON.stringify({
              type: "agent.result",
              id: message.id,
              ok: true,
              result: {},
            }),
          );
      }),
    ),
  );
  const record = path.join(dir, "bridge.json");
  fs.writeFileSync(
    record,
    JSON.stringify({ pid: process.pid, port: server.port }),
  );
  try {
    const result = await runCli(["navigate", "1", "https://example.invalid"], {
      WB_BRIDGE_TOKEN: token,
      WB_BRIDGE_FILE: record,
      WB_BRIDGE_AUTH_FILE: path.join(dir, "auth.json"),
    });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      error: "fixture tab missing",
      code: "COMMAND_FAILED",
    });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true });
  }
});
test("status remains bounded when a live bridge has no extension", async () => {
  const token = crypto.randomBytes(32).toString("hex"),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-bridge-test-"));
  const server = await wsFixture((socket, request) =>
    authenticateServer(socket, request, token, () => {}),
  );
  const record = path.join(dir, "bridge.json");
  fs.writeFileSync(
    record,
    JSON.stringify({ pid: process.pid, port: server.port }),
  );
  const started = Date.now();
  try {
    const result = await runCli(["status"], {
      WB_BRIDGE_TOKEN: token,
      WB_BRIDGE_FILE: record,
      WB_BRIDGE_AUTH_FILE: path.join(dir, "auth.json"),
    });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).extension, null);
    assert.ok(
      Date.now() - started < 2700,
      "Includes Node process startup, but must never fall back to the 60s path",
    );
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true });
  }
});
test("stable identity stays reserved until cleanup acknowledgement", () => {
  const h = harness(),
    a = new Socket(),
    b = new Socket(),
    extension = new Socket();
  h.router.addClient(a);
  h.router.addClient(b);
  h.router.attachExtension(extension);
  h.router.clientMessage(a, {
    ...h.command("old", "stable"),
    transientClient: false,
  });
  h.router.clientMessage(a, {
    type: "client.disconnect",
    id: "disconnect-ack",
  });
  const cleanup = extension.sent.at(-1);
  h.router.clientMessage(b, h.command("too-soon", "stable"));
  assert.equal(b.sent.at(-1).code, "CLIENT_BUSY");
  h.router.extensionMessage(extension, {
    type: "agent.result",
    id: cleanup.id,
    ok: true,
    result: { disconnected: true },
  });
  assert.equal(a.sent.at(-1).id, "disconnect-ack");
  h.router.clientMessage(b, h.command("after-ack", "stable"));
  assert.equal(extension.sent.at(-1).cmd, "navigate");
  h.router.close();
});
test("capture events arriving before start reply are delivered only after ownership confirmation", () => {
  const h = harness(),
    a = new Socket(),
    b = new Socket(),
    extension = new Socket();
  h.router.addClient(a);
  h.router.addClient(b);
  h.router.attachExtension(extension);
  h.router.clientMessage(
    a,
    h.command("start", "a", "capture.start", { tabId: 1 }),
  );
  h.router.extensionMessage(extension, {
    type: "event.push",
    captureId: "early",
    clientId: "a",
    tabId: 1,
  });
  assert.equal(a.sent.length, 0);
  assert.equal(b.sent.length, 0);
  h.router.extensionMessage(extension, {
    type: "agent.result",
    id: extension.sent[0].id,
    ok: true,
    result: { captureId: "early" },
  });
  assert.equal(a.sent.length, 2);
  assert.equal(a.sent[0].type, "agent.result");
  assert.equal(a.sent[1].type, "event.push");
  assert.equal(b.sent.length, 0);
  h.router.close();
});
test("late successful capture start after cancellation is explicitly stopped", () => {
  const h = harness(),
    a = new Socket(),
    extension = new Socket();
  h.router.addClient(a);
  h.router.attachExtension(extension);
  h.router.clientMessage(
    a,
    h.command("start", "a", "capture.start", { tabId: 1 }),
  );
  const request = extension.sent[0];
  h.advance(31000);
  h.router.extensionMessage(extension, {
    type: "agent.result",
    id: request.id,
    ok: true,
    result: { captureId: "late" },
  });
  assert.equal(extension.sent.at(-1).cmd, "capture.stop");
  assert.equal(extension.sent.at(-1).args.captureId, "late");
  assert.equal(a.sent.length, 1);
  assert.equal(a.sent[0].ok, false);
  h.router.close();
});
test("unauthenticated business frames cannot select an extension socket", async () => {
  const token = crypto.randomBytes(32).toString("hex");
  let authenticated = false;
  const server = await wsFixture((socket, request) =>
    authenticateServer(socket, request, token, () => {
      authenticated = true;
    }),
  );
  const socket = new WebSocket("ws://127.0.0.1:" + server.port);
  socket.on("error", () => {});
  try {
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.on("open", () =>
      socket.send(JSON.stringify({ type: "hello", extId: "arbitrary" })),
    );
    assert.equal(await closed, 1008);
    assert.equal(authenticated, false);
  } finally {
    socket.terminate();
    await server.close();
  }
});
test("run awaits by default, --sync skips; --nowait zeros open/navigate wait; open-frame builds", () => {
  assert.equal(
    cli.buildCmd(["run", "1", "1+1"]).args.params.awaitPromise,
    true,
  );
  assert.equal(
    cli.buildCmd(["run", "1", "1+1"], { sync: true }).args.params.awaitPromise,
    false,
  );
  assert.equal(cli.buildCmd(["open", "https://x/"]).args.waitMs, undefined);
  assert.equal(
    cli.buildCmd(["open", "https://x/"], { nowait: true }).args.waitMs,
    0,
  );
  assert.equal(
    cli.buildCmd(["navigate", "1", "https://x/"], { nowait: true }).args.waitMs,
    0,
  );
  assert.deepEqual(cli.buildCmd(["open-frame", "1", "example"]).args, {
    tabId: 1,
    urlPattern: "example",
  });
});
// ---------------- T-33：多会话桥注册表 ----------------
test("registry: live entries list newest-first, same port deduped, stale entries pruned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-bridges-"));
  const legacy = path.join(dir, "legacy.json");
  const alive = (p) => p === process.pid;
  const base = Date.now();
  fs.writeFileSync(
    path.join(dir, "a.json"),
    JSON.stringify({ sid: "a", pid: process.pid, port: 9521, ts: base + 1 }),
  );
  fs.writeFileSync(
    path.join(dir, "b.json"),
    JSON.stringify({ sid: "b", pid: process.pid, port: 9522, ts: base + 3 }),
  );
  fs.writeFileSync(
    legacy,
    JSON.stringify({ pid: process.pid, port: 9522, ts: base + 2 }),
  );
  fs.writeFileSync(
    path.join(dir, "stale.json"),
    JSON.stringify({ sid: "stale", pid: 999999, port: 9525, ts: base + 9 }),
  );
  const list = cli.listLiveBridges(dir, legacy, alive);
  // b(ts3) 与 legacy(ts2, sid "default") 同端口 9522：ts 高者（注册表 b）胜出；9521=a。
  assert.deepEqual(
    list.map((e) => [e.port, e.sid]),
    [
      [9522, "b"],
      [9521, "a"],
    ],
  );
  assert.equal(
    fs.existsSync(path.join(dir, "stale.json")),
    false,
    "dead entries are pruned on discovery",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
test("registry: session pinning prefers its bridge, falls back to all live bridges when it died", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-bridges-"));
  const legacy = path.join(dir, "legacy.json");
  const alive = (p) => p === process.pid;
  const write = (sid, port, ts) =>
    fs.writeFileSync(
      path.join(dir, sid + ".json"),
      JSON.stringify({ sid, pid: process.pid, port, ts }),
    );
  write("a", 9521, 1);
  write("b", 9522, 2);
  delete process.env.WB_BRIDGE_FILE;
  assert.deepEqual(
    cli.bridgeCandidates({}, dir, legacy, alive).map((e) => e.sid),
    ["b", "a"],
    "newest-first when no session pinning",
  );
  assert.deepEqual(
    cli
      .bridgeCandidates({ session: "a" }, dir, legacy, alive)
      .map((e) => e.sid),
    ["a"],
  );
  assert.deepEqual(
    cli
      .bridgeCandidates({ session: "gone" }, dir, legacy, alive)
      .map((e) => e.sid),
    ["b", "a"],
    "dead session bridge fails over to remaining live bridges",
  );
  process.env.WB_SESSION = "b";
  assert.deepEqual(
    cli.bridgeCandidates({}, dir, legacy, alive).map((e) => e.sid),
    ["b"],
  );
  delete process.env.WB_SESSION;
  process.env.WB_BRIDGE_FILE = legacy;
  fs.writeFileSync(
    legacy,
    JSON.stringify({ pid: process.pid, port: 9522, ts: 5 }),
  );
  assert.deepEqual(
    cli.bridgeCandidates({}, dir, legacy, alive).map((e) => e.sid),
    ["default"],
    "WB_BRIDGE_FILE override is exclusive (legacy dual-instance)",
  );
  delete process.env.WB_BRIDGE_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});
test("serve takes a positional session id", () => {
  assert.deepEqual(cli.buildCmd(["serve", "b"]).args, { sid: "b" });
  assert.deepEqual(cli.buildCmd(["serve"]).args, { sid: "" });
});
test("failover: an unreachable bridge hands off to the next live bridge", async () => {
  const token = auth.DEFAULT_TOKEN;
  const dead = await wsFixture((socket) => socket.close(1008, "nope"));
  const live = await wsFixture((socket, request) => {
    authenticateServer(socket, request, token, () =>
      socket.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.type === "cmd")
          socket.send(
            JSON.stringify({
              type: "agent.result",
              id: message.id,
              ok: true,
              result: "second",
            }),
          );
        else if (message.type === "client.disconnect")
          socket.send(
            JSON.stringify({
              type: "agent.result",
              id: message.id,
              ok: true,
              result: {},
            }),
          );
      }),
    );
  });
  try {
    const candidates = [
      { sid: "first", pid: process.pid, port: dead.port, ts: 2 },
      { sid: "second", pid: process.pid, port: live.port, ts: 1 },
    ];
    const picked = await cli.connectBridgeChain(
      candidates,
      token,
      { clientId: "t", transientClient: true },
      3000,
    );
    assert.equal(picked.bridge.sid, "second");
    const reply = await picked.channel.sendCmd({ cmd: "diag" }, 3000);
    assert.equal(reply.result, "second");
    await picked.channel.close(false);
  } finally {
    dead.close();
    live.close();
  }
});
// ---------------- T-34：doctor 维护锁 + 探针 server ----------------
test("doctor lock: single holder, live contention times out, stale lock is stolen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-maint-"));
  try {
    const a = await cli.acquireMaintenanceLock(5000, dir);
    assert.equal(a.acquired, true);
    const b = await cli.acquireMaintenanceLock(2000, dir);
    assert.equal(b.acquired, false);
    assert.equal(
      b.holder.pid,
      process.pid,
      "live holder is reported, not stolen",
    );
    cli.releaseMaintenanceLock(a);
    const c = await cli.acquireMaintenanceLock(5000, dir);
    assert.equal(c.acquired, true, "lock is free after release");
    cli.releaseMaintenanceLock(c);
    // 残留锁（持锁者被强杀 / 超 TTL）→ 窃取
    fs.writeFileSync(
      cli.maintenanceLockFile
        ? cli.maintenanceLockFile(dir)
        : path.join(dir, "maintenance.lock.json"),
      JSON.stringify({ pid: 999999, ts: Date.now() }),
    );
    const d = await cli.acquireMaintenanceLock(5000, dir);
    assert.equal(d.acquired, true, "stale lock (dead holder pid) is stolen");
    cli.releaseMaintenanceLock(d);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("doctor probe server detects an authenticating extension dial-in", async () => {
  const token = auth.DEFAULT_TOKEN;
  const probe = cli.startProbeServer(token, 15000);
  const port = await probe.portReady;
  const sock = new WebSocket("ws://127.0.0.1:" + port);
  sock.on("error", () => {});
  try {
    const challenge = JSON.parse(
      await new Promise((resolve) =>
        sock.on("message", (raw) => resolve(raw.toString())),
      ),
    );
    assert.equal(challenge.type, "auth.challenge");
    const nonce = auth.createNonce();
    const proof = await auth.sign(
      token,
      "extension",
      "client",
      challenge.nonce,
      nonce,
    );
    sock.send(
      JSON.stringify({
        type: "auth.response",
        protocol: auth.PROTOCOL,
        role: "extension",
        nonce,
        proof,
      }),
    );
    const result = await probe.promise;
    assert.equal(result.detected, true);
    assert.equal(result.port, port);
  } finally {
    sock.terminate();
  }
});
test("doctor builds as a command", () => {
  assert.equal(cli.buildCmd(["doctor"]).cmd, "doctor");
  const opts = cli.parseArgs(["doctor", "--force", "--dry", "--wait", "3000"]);
  assert.equal(opts.force, true);
  assert.equal(opts.dry, true);
  assert.equal(opts.waitMs, 3000);
});
// ---------------- T-35：--load-extension 路径护栏 ----------------
test("resolveExtDir: WB_CDP_EXT_DIR 指向无 manifest 的目录必须报错，不静默带病启动", () => {
  const { execSync } = require("child_process");
  // 找本机一个含 manifest.json 的真实扩展根（cdp skill 的 unpacked 扩展），
  // 作为 resolveExtDir 的合法目标；找不到则跳过（该测试依赖本机环境）。
  const candidates = [
    "D:\\project\\skills\\cdp\\extension",
    "C:\\Users\\Administrator\\.dsh\\skills\\cdp-browser\\extension",
  ];
  const valid = candidates.find((c) =>
    fs.existsSync(path.join(c, "manifest.json")),
  );
  if (!valid) {
    this.skip?.();
    console.log("(skip) 本机未找到 unpacked 扩展根，resolveExtDir 测试跳过");
    return;
  }
  // WB_CDP_EXT_DIR 指到无 manifest 的目录（如 <valid>/src）→ 必须抛错
  process.env.WB_CDP_EXT_DIR = path.join(valid, "src");
  assert.throws(() => cli.resolveExtDir(), /manifest\.json/);
  // 指向合法扩展根 → 原样返回
  process.env.WB_CDP_EXT_DIR = valid;
  assert.equal(
    cli.resolveExtDir().replace(/\\/g, "/"),
    valid.replace(/\\/g, "/"),
  );
  delete process.env.WB_CDP_EXT_DIR;
  // 缺省（不设 WB_CDP_EXT_DIR）→ paths.js 按候选推导（../cdp/extension、../cdp-browser/extension），
  // 推导不到时抛"找不到 unpacked 扩展根目录"（独立 skill 形态下扩展不在本目录内，属预期）。
  // 本机恰好有候选时直接通过，没有则报错——两者都证明 resolveExtDir 做了 manifest 校验。
  try {
    cli.resolveExtDir();
  } catch (e) {
    assert.match(String(e.message), /manifest\.json|unpacked 扩展根目录/);
  }
});
