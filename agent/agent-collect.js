"use strict";
// Synapse agent-side WS bridge (skill 层：跑在 node 里，不在浏览器扩展内).
// Paths are no longer hard-coded to the skill source dir; they resolve through
// ./paths.js so WB_DATA_DIR / WB_BRIDGE_FILE / WB_BRIDGE_DIR / WB_CDP_EXT_DIR
// can point runtime data and the unpacked extension wherever the user wants.
const { WebSocketServer, WebSocket } = require("./vendor/ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const { createBridgeRouter } = require("./bridge-router");
const {
  readToken,
  pairToken,
  authenticateServer,
  authenticateClient,
} = require("./bridge-auth");
const {
  BRIDGE_DIR,
  BRIDGE_FILE,
  resolveExtDir: _pathsResolveExtDir,
} = require("./paths");
const registry = require("./registry");
const { renderUsage } = require("./commands");
const { readJson, writeJsonAtomic, unlinkQuiet } = require("./lib/json-store");
const { wait, failReply, failEvaluation, writeFailure } = require("./lib/ui");
const {
  buildCaptureSessionResult,
  triggerCapture,
  doCaptureMany,
} = require("./capture");
const {
  bindAgentWs,
  createChannel,
  connectBridge,
  connectDirect,
  connectBridgeChain,
  executeCommand,
} = require("./transport");
const {
  summarizeDiag,
  probeStatusSnapshot,
  runStatus,
  dataDir,
  maintenanceLockFile,
  appendMaintenanceLog,
  acquireMaintenanceLock,
  releaseMaintenanceLock,
  findEdgeExe,
  killAllEdge,
  clearSwCaches,
  launchEdge,
  startProbeServer,
  runDoctor,
} = require("./doctor");
const { usage, parseArgs, buildCmd, validateOptions } = require("./cli");
const {
  SID_RE,
  readBridge,
  writeBridge,
  unlinkBridge,
  writeRegistryEntry,
  unlinkRegistryEntry,
  pidAlive,
  readLiveEntry,
  listLiveBridges,
  bridgeCandidates,
} = registry;
const {
  PORT_RANGE_START,
  PORT_RANGE_END,
  CMD_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  MAINT_LOCK_TTL_MS,
} = require("./config");




// 逐个试连候选桥（连接层故障转移；命令尚未发出，安全）。全失败抛 NO_BRIDGE。
async function runServe(sid, token, opts = {}) {
  const { srv, port } = await bindAgentWs();
  const router = createBridgeRouter();
  const session = SID_RE.test(sid)
    ? sid
    : "b-" + crypto.randomBytes(3).toString("hex");
  writeRegistryEntry(session, port);
  // --shared：额外写遗留单文件（data/bridge.json 或 WB_BRIDGE_FILE），供未升级脚本发现。
  if (opts.shared) {
    try {
      writeBridge(port);
    } catch (error) {
      console.error(
        "[serve] shared bridge record write failed: " + error.message,
      );
    }
  }
  srv.on("connection", (socket, request) => {
    let role = null;
    socket.on("close", () => router.disconnect(socket));
    authenticateServer(socket, request, token, (authenticatedRole) => {
      role = authenticatedRole;
      if (role === "extension") {
        if (!router.attachExtension(socket)) return;
      } else router.addClient(socket);
      socket.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch (_) {
          return;
        }
        if (role === "extension") router.extensionMessage(socket, message);
        else router.clientMessage(socket, message);
      });
    });
  });
  console.error(
    "[serve] session=" +
      session +
      " listening on 127.0.0.1:" +
      port +
      "（本会话 one-shot：WB_SESSION=" +
      session +
      "）",
  );
  const shutdown = () => {
    router.close();
    unlinkRegistryEntry(session);
    if (opts.shared) unlinkBridge();
    for (const socket of srv.clients) socket.terminate();
    srv.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise((resolve) => srv.once("close", resolve));
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
}
// --keep：临时会话桥 = serve 语义（注册表条目 + 多客户端路由），但不驻留后台：
// 自身作为第一个客户端执行本次命令，随后 park 到 Ctrl+C。注册表条目让同会话
// 后续 one-shot（WB_SESSION=<打印的 sid>）直接毫秒级复用，不必再走 60s 直连。
// 旧 --keep 的直连 server 只收扩展、拒绝其它客户端，是"会话桥"不可复用的根源。
async function runKeep(command, token, opts) {
  const { srv, port } = await bindAgentWs();
  const router = createBridgeRouter();
  const rawSid = opts.session || process.env.WB_SESSION || "";
  const session = SID_RE.test(rawSid)
    ? rawSid
    : "k-" + crypto.randomBytes(3).toString("hex");
  writeRegistryEntry(session, port);
  srv.on("connection", (socket, request) => {
    let role = null;
    socket.on("close", () => router.disconnect(socket));
    authenticateServer(socket, request, token, (authenticatedRole) => {
      role = authenticatedRole;
      if (role === "extension") {
        if (!router.attachExtension(socket)) return;
      } else router.addClient(socket);
      socket.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch (_) {
          return;
        }
        if (role === "extension") router.extensionMessage(socket, message);
        else router.clientMessage(socket, message);
      });
    });
  });
  console.error(
    "[keep] session=" +
      session +
      " bridge on 127.0.0.1:" +
      port +
      "（同会话 one-shot 复用：WB_SESSION=" +
      session +
      "；Ctrl+C 结束）",
  );
  const record = { sid: session, pid: process.pid, port, ts: Date.now() };
  let channel = null;
  try {
    channel = await connectBridge(record, token, {
      ...opts,
      skipGracefulDisconnect: true,
    });
    const result = await executeCommand(channel, command, opts);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    if (channel) await channel.close(false);
    router.close();
    unlinkRegistryEntry(session);
    for (const socket of srv.clients) socket.terminate();
    await new Promise((resolve) => srv.close(resolve));
  }
}
// 多会话（T-33）：逐个试连候选桥（会话桥优先），总时限仍为 STATUS_TIMEOUT_MS；
// 不回落 60s 直连路径。bridgeAlive 与 extension 可达性解耦（zhipin 探针只信
// bridgeAlive，避免把"扩展黑坑 T-23"误判为"桥死"而反复重启 serve）。
// probeStatusSnapshot 只做探测（doctor 复用）；runStatus 负责输出与退出码。

// ---------------- 链路医生 + 多会话协调恢复（T-34） ----------------
// 多会话痛点：每个会话看到"扩展不活"就各自手跑 T-17（taskkill Edge + 清缓存 +
// 重启）→ N 个会话 = N 次连环关开浏览器；且多数"不活"只是 SW 重拨窗口
// （5s rescan / 30s keepalive）未过。doctor 把恢复收敛成一条协调命令：
//   1) 快查：任一活桥的扩展 diag 正常 → 直接放行；
//   2) 礼貌等待（默认 = --wait，60s）：宿主一个探针 WS 端口接 SW 重拨，同时
//      轮询各活桥——等期间别的会话的 doctor/恢复动作也会让它变好；
//   3) 协调硬刷：data/maintenance.lock.json（O_EXCL 原子锁，TTL 180s）保证同一
//      时刻只有一个会话执行 kill+清缓存+重启；排上的会话等锁释放后复查健康，
//      别人已修好就直接放行，不再杀一次浏览器。硬刷明细写 data/maintenance.log。
// 解析要加载的扩展根目录并校验 manifest.json 存在（T-35 护栏）。
// 事故：某次把 --load-extension 指到了 extension/src（子目录，无清单）→
// Edge 启动报「无法加载扩展：清单文件丢失或不可读取」。launch 前必须确认
// 目标目录确实含 manifest.json，指错一层（src / 其它子目录）立即报错而非带病启动。
function resolveExtDir() {
  // 独立 skill 形态：扩展本体不在本 skill 内，默认路径由 paths.js 按候选推导
  // （WB_CDP_EXT_DIR 显式 → ../cdp/extension → ../cdp-browser/extension → 报错）。
  return _pathsResolveExtDir();
}
// 宿主一个探针 WS 端口：扩展 SW 的 5s rescan 会把它当 agent 拨入，
// 认证通过且 role=extension 即证明 SW 活着（无需任何桥在运行）。
// 返回 { promise: {detected, ms, port?, error?}, portReady }。
async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.rest.length) usage();
  const command = buildCmd(opts.rest, opts);
  if (command.cmd === "pair") {
    process.stdout.write(
      JSON.stringify({ protocol: "wb-cdp-ws/2", token: pairToken() }) + "\n",
    );
    return;
  }
  validateOptions(opts);
  opts.transientClient = !opts.clientId;
  opts.clientId = opts.clientId || "cli-" + crypto.randomUUID();
  if (command.cmd === "status") {
    await runStatus(opts);
    return;
  }
  const token = readToken();
  if (command.cmd === "doctor") {
    await runDoctor(token, opts);
    return;
  }
  if (command.cmd === "serve") {
    await runServe(command.args?.sid, token, opts);
    return;
  }
  if (opts.keep) {
    await runKeep(command, token, opts);
    return;
  }
  let channel = null;
  let usedBridge = null;
  try {
    // 多会话发现（T-33）：候选 = 会话桥优先 + 其它活桥（ts 降序）+ 遗留单文件；
    // 逐个试连，全失败才回落 60s 直连慢路径（命令尚未发出，回落安全）。
    const candidates = bridgeCandidates(opts);
    if (candidates.length) {
      try {
        const picked = await connectBridgeChain(candidates, token, opts);
        channel = picked.channel;
        usedBridge = picked.bridge;
      } catch (error) {
        if (error.code !== "NO_BRIDGE") throw error;
      }
    }
    if (!channel) {
      channel = await connectDirect(token, opts);
      if (candidates.length)
        console.error(
          "[collect] no reachable bridge (" +
            candidates.length +
            " tried); falling back to direct slow path (wait ≤ " +
            opts.waitMs +
            "ms)",
        );
    } else {
      console.error(
        "[collect] via bridge sid=" +
          usedBridge.sid +
          " port=" +
          usedBridge.port,
      );
    }
    const result = await executeCommand(channel, command, opts);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    if (channel) await channel.close(false);
  }
}
if (require.main === module) main().catch(writeFailure);
module.exports = {
  parseArgs,
  buildCmd,
  main,
  createChannel,
  connectBridge,
  runStatus,
  failReply,
  failEvaluation,
  writeFailure,
  doCaptureMany,
  buildCaptureSessionResult,
  executeCommand,
  validateOptions,
  readBridge,
  writeRegistryEntry,
  unlinkRegistryEntry,
  pidAlive,
  readLiveEntry,
  listLiveBridges,
  bridgeCandidates,
  connectBridgeChain,
  runKeep,
  runServe,
  BRIDGE_DIR,
  BRIDGE_FILE,
  probeStatusSnapshot,
  runDoctor,
  startProbeServer,
  acquireMaintenanceLock,
  releaseMaintenanceLock,
  maintenanceLockFile,
  findEdgeExe,
  resolveExtDir,
};
