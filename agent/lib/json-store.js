"use strict";
// JSON 文件读写的统一入口。
//
// 桥注册表、遗留 bridge.json、配对 token 都是"写一半被杀 → 文件损坏 → 下次启动直接抛"
// 的高危点，所以写入一律走 writeJsonAtomic：先写同目录临时文件再 rename，
// rename 在同分区上是原子的，读到的永远是完整内容。
const fs = require("fs");
const path = require("path");

// 读不到 / 解析失败 / 结构不对，一律返回 fallback，调用方不需要 try/catch。
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, value, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  const body = JSON.stringify(value) + "\n";
  try {
    fs.writeFileSync(tmp, body, options.mode ? { mode: options.mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw error;
  }
}

// 删不掉（不存在、被占用）不算错——清理路径上不该因为一个 ENOENT 中断。
function unlinkQuiet(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { readJson, writeJsonAtomic, unlinkQuiet };
