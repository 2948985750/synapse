"use strict";
// 针对 review 修掉的 bug 的回归测试（每条对应一次真实崩溃/泄漏）。
const test = require("node:test");
const assert = require("node:assert");
const { createBridgeRouter } = require("./bridge-router");
const { buildCaptureSessionResult } = require("./capture");

function fakeSocket(name) {
  const sent = [];
  return {
    name,
    readyState: 1,
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close(code, reason) {
      this.readyState = 3;
      this.closed = { code, reason };
    },
    terminate() {
      this.readyState = 3;
    },
  };
}

// bug①：扩展收到 client.disconnect 后不回包（MV3 SW 被挂起）时，
// 这条客户端必须被超时释放，而不是永久停在 cleaning 状态。
test("cleanup is released by timeout when the extension never acknowledges", () => {
  const timers = [];
  const router = createBridgeRouter({
    setTimer: (fn) => {
      timers.push(fn);
      return { id: timers.length };
    },
    clearTimer: () => {},
  });
  const client = fakeSocket("client");
  const extension = fakeSocket("extension");
  router.addClient(client);
  router.attachExtension(extension);

  router.clientMessage(client, {
    type: "cmd",
    id: "c1",
    clientId: "k1",
    cmd: "list",
    args: {},
    timeoutMs: 5000,
  });
  assert.equal(extension.sent.length, 1, "命令应已转发给扩展");

  router.clientMessage(client, { type: "client.disconnect", id: "d1" });
  const cleanupTimer = timers[timers.length - 1];
  assert.equal(typeof cleanupTimer, "function", "清理应挂上超时定时器");

  cleanupTimer();
  const reply = client.sent.find(
    (m) => m.type === "agent.result" && m.code === "CLEANUP_TIMEOUT",
  );
  assert.ok(reply, "超时后必须回 CLEANUP_TIMEOUT，而不是让客户端无声卡住");
  assert.equal(reply.id, "d1");
});

// bug⑥：写坏的 --filter 以前抛原生 SyntaxError，最终被归一成 COMMAND_FAILED，
// 用户看不出是自己正则写错了。
test("invalid --filter yields INVALID_FILTER instead of a bare SyntaxError", async () => {
  await assert.rejects(
    () =>
      buildCaptureSessionResult(
        async () => ({ ok: true, result: {} }),
        { tabId: 1, action: "wait", captureId: "cap" },
        [],
        { filter: "[", durationMs: 10 },
        new Map(),
      ),
    (error) => {
      assert.equal(error.code, "INVALID_FILTER");
      assert.match(error.message, /--filter/);
      return true;
    },
  );
});

console.log("ALL-REGRESSIONS-OK (2 cases)");
