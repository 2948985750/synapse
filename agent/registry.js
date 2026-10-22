"use strict";
// 桥发现记录：遗留单文件 bridge.json + 多会话注册表 bridges/<sid>.json。
//
// 注册表要解决的问题：单文件在多会话下互相覆盖（后写者赢），赢家退出即删掉唯一
// 发现记录，其它会话全跌回 60s 直连慢路径。改成一条会话一个文件后：互不踩踏、
// 死条目自动清理、会话可显式定位（--session / WB_SESSION），无定位时故障转移到任一活桥。
const path = require("path");
const fs = require("fs");
const { BRIDGE_DIR, BRIDGE_FILE } = require("./paths");
const { readJson, writeJsonAtomic, unlinkQuiet } = require("./lib/json-store");

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function validPort(port, allowZero) {
  return (
    Number.isInteger(port) &&
    (allowZero ? port >= 0 : port > 0) &&
    port <= 65535
  );
}

// ---------------- 遗留单文件 ----------------

function readBridge() {
  const b = readJson(BRIDGE_FILE);
  if (!b || !Number.isInteger(b.pid) || b.pid <= 0 || !validPort(b.port))
    return null;
  try {
    process.kill(b.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return null;
    throw error;
  }
  return b;
}

function writeBridge(port) {
  writeJsonAtomic(BRIDGE_FILE, { pid: process.pid, port, ts: Date.now() });
}

function unlinkBridge() {
  const b = readJson(BRIDGE_FILE);
  if (b && b.pid === process.pid) unlinkQuiet(BRIDGE_FILE);
}

// ---------------- 多会话注册表 ----------------

function writeRegistryEntry(sid, port, dir = BRIDGE_DIR) {
  if (!SID_RE.test(sid))
    throw new Error("Invalid bridge session id " + JSON.stringify(sid));
  writeJsonAtomic(path.join(dir, sid + ".json"), {
    sid,
    pid: process.pid,
    port,
    ts: Date.now(),
  });
}

function unlinkRegistryEntry(sid, dir = BRIDGE_DIR) {
  const file = path.join(dir, sid + ".json");
  const e = readJson(file);
  if (e && e.pid === process.pid) unlinkQuiet(file);
}

// 读单个条目文件：结构校验 + pid 活性；死条目就地清理（serve 被 SIGKILL 的残留）。
function readLiveEntry(file, fallbackSid, alive = pidAlive) {
  const e = readJson(file);
  if (!e || !Number.isInteger(e.pid) || e.pid <= 0 || !validPort(e.port))
    return null;
  if (!alive(e.pid)) {
    unlinkQuiet(file);
    return null;
  }
  return {
    sid: SID_RE.test(e.sid || "") ? e.sid : fallbackSid || "default",
    pid: e.pid,
    port: e.port,
    ts: Number(e.ts) || 0,
  };
}

// 枚举全部活桥：注册表条目 + 遗留 bridge.json（sid "default"，老 daemon 兼容），
// 同端口去重（取更新者），按 ts 降序。
function listLiveBridges(
  dir = BRIDGE_DIR,
  legacyFile = BRIDGE_FILE,
  alive = pidAlive,
) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {}
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const e = readLiveEntry(path.join(dir, name), name.slice(0, -5), alive);
    if (e) out.push(e);
  }
  const legacy = readLiveEntry(legacyFile, "default", alive);
  if (legacy) out.push(legacy);
  out.sort((a, b) => b.ts - a.ts);
  const byPort = new Map();
  for (const e of out) if (!byPort.has(e.port)) byPort.set(e.port, e);
  return [...byPort.values()];
}

// one-shot / status 的候选桥顺序：
//   显式 WB_BRIDGE_FILE（遗留双实例）独占 → 注册表+遗留全量活桥（ts 降序）
//   → --session/WB_SESSION 指定桥排前（该桥已死时仍保留全量候选做故障转移）。
// dir/legacyFile/alive 可注入（单测用临时目录；缺省 = 模块级默认）。
function bridgeCandidates(
  opts = {},
  dir = BRIDGE_DIR,
  legacyFile = BRIDGE_FILE,
  alive = pidAlive,
) {
  if (process.env.WB_BRIDGE_FILE) {
    const e = readLiveEntry(
      path.resolve(process.env.WB_BRIDGE_FILE),
      "default",
      alive,
    );
    return e ? [e] : [];
  }
  const all = listLiveBridges(dir, legacyFile, alive);
  const want = opts.session || process.env.WB_SESSION || "";
  if (!want) return all;
  const match = all.filter((e) => e.sid === want);
  return match.length ? match : all;
}

module.exports = {
  SID_RE,
  pidAlive,
  readBridge,
  writeBridge,
  unlinkBridge,
  writeRegistryEntry,
  unlinkRegistryEntry,
  readLiveEntry,
  listLiveBridges,
  bridgeCandidates,
};
