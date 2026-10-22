#!/usr/bin/env node
"use strict";
// 把 synapse 的 node 侧实现（skill 层）同步到 cdp 的 vendored 位置，
// 或校验两边是否已经漂移。
//
// 为什么会有 vendored 副本：cdp 要能单独分发（~/.dsh/skills/cdp-browser 这种
// 拷贝形态），不能 require 仓库外的路径；但实现只能有一份源，所以由本脚本
// 机械复制，并用 --check 在两边 CI / 本地测试里拦住手工改动导致的漂移。
//
// 注意：native-host 不是扩展的一部分（extension/store/build-store.js 明确把它
// 排除在商店包外），它只是 node 代码的历史存放位置，保留这个路径是为了让 cdp
// 里 ~30 处 `extension/native-host/agent-collect.js` 的引用不必改动。
//
// 用法：
//   node scripts/sync-cdp-vendor.js            # 写入（同步）
//   node scripts/sync-cdp-vendor.js --check    # 只校验，有漂移则退出码 1
//   node scripts/sync-cdp-vendor.js --cdp <dir># 指定 cdp skill 目录
const fs = require("fs");
const path = require("path");

const SRC_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(SRC_ROOT, "agent");
const SKILLS_DIR = path.dirname(SRC_ROOT);

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const cdpIdx = argv.indexOf("--cdp");
const CDP = cdpIdx >= 0 && argv[cdpIdx + 1]
  ? path.resolve(argv[cdpIdx + 1])
  : path.join(SKILLS_DIR, "cdp");
const DEST = path.join(CDP, "extension", "native-host");

const FILES = [
  "agent-collect.js",
  "bridge-router.js",
  "bridge-auth.js",
  "ws-auth.js",
  "paths.js",
  "test-bridge.js",
];
const EXTRA_DIRS = ["vendor/ws"];

function walk(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function plan() {
  const items = [];
  for (const f of FILES) items.push({ rel: f, src: path.join(SRC, f), dest: path.join(DEST, f) });
  for (const d of EXTRA_DIRS) {
    for (const rel of walk(path.join(SRC, d), d)) {
      items.push({ rel, src: path.join(SRC, rel), dest: path.join(DEST, rel) });
    }
  }
  return items;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error("源目录不存在：" + SRC);
    process.exit(2);
  }
  if (!fs.existsSync(CDP)) {
    console.error("目标 cdp 目录不存在：" + CDP + "（用 --cdp 指定）");
    process.exit(2);
  }
  const items = plan();
  const drifted = [];
  const missing = [];

  for (const it of items) {
    const srcBuf = fs.readFileSync(it.src);
    if (!fs.existsSync(it.dest)) {
      missing.push(it.rel);
      if (!CHECK) {
        fs.mkdirSync(path.dirname(it.dest), { recursive: true });
        fs.writeFileSync(it.dest, srcBuf);
      }
      continue;
    }
    const destBuf = fs.readFileSync(it.dest);
    if (!srcBuf.equals(destBuf)) {
      drifted.push(it.rel);
      if (!CHECK) {
        fs.mkdirSync(path.dirname(it.dest), { recursive: true });
        fs.writeFileSync(it.dest, srcBuf);
      }
    }
  }

  const label = CHECK ? "check" : "sync";
  if (CHECK) {
    if (!drifted.length && !missing.length) {
      console.log("[" + label + "] vendored 副本与源一致（" + items.length + " 个文件）");
      return 0;
    }
    console.error("[" + label + "] 检测到漂移，cdp 的 vendored 副本不是从源生成的：");
    for (const f of missing) console.error("  missing: " + f);
    for (const f of drifted) console.error("  drifted: " + f);
    console.error("修复：node scripts/sync-cdp-vendor.js");
    return 1;
  }
  console.log("[" + label + "] 已同步 " + (drifted.length + missing.length) + " / " + items.length + " 个文件 → " + DEST);
  if (drifted.length) for (const f of drifted) console.log("  updated: " + f);
  if (missing.length) for (const f of missing) console.log("  created: " + f);
  return 0;
}

process.exit(main());
