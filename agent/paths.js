"use strict";
// synapse 的路径集中配置：桥注册表 / 维护锁 / 遗留单文件 / 扩展根目录都从这里解析。
//
// 同一份文件要能同时放在两种布局下，且解析结果完全一致：
//   ① 独立 skill   <repo>/synapse/                     （synapse-skill 仓库）
//   ② cdp 内 vendored <cdp>/extension/native-host/      （cdp 的 node 侧副本，由同步脚本生成）
//
// 所以这里不按 __dirname 的相对深度硬推，而是向上找含 SKILL.md 的目录作为 skill 根，
// 再以 skill 根的上一级（siblings 目录）去找同级的 cdp / cdp-browser 扩展。
const fs = require("fs");
const path = require("path");
const os = require("os");

// 向上找含 SKILL.md 的目录 = skill 根。找不到（例如被单独拷走后）退回上一级。
function findSkillRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.join(start, "..");
}

const SKILL_ROOT = path.resolve(findSkillRoot(__dirname));
// siblings 目录：<skills>/ ；扩展本体是它的同级 skill。
const SKILLS_DIR = path.dirname(SKILL_ROOT);

// 数据根：默认 <skill>/data（可被 WB_DATA_DIR 覆盖，如 ~/.synapse）
const DATA_ROOT = process.env.WB_DATA_DIR
  ? path.resolve(process.env.WB_DATA_DIR)
  : path.join(SKILL_ROOT, "data");

// 桥注册表目录（多会话）：<data>/bridges
const BRIDGE_DIR = process.env.WB_BRIDGE_DIR
  ? path.resolve(process.env.WB_BRIDGE_DIR)
  : path.join(DATA_ROOT, "bridges");

// 遗留单文件桥记录：<data>/bridge.json
const BRIDGE_FILE = process.env.WB_BRIDGE_FILE
  ? path.resolve(process.env.WB_BRIDGE_FILE)
  : path.join(DATA_ROOT, "bridge.json");

// doctor 硬刷用的扩展根目录（含 manifest.json 的 unpacked 扩展）。
// 本 skill 不含扩展本体，解析顺序：
//   WB_CDP_EXT_DIR（显式）→ 同级 <skills>/cdp/extension → <skills>/cdp-browser/extension
//   → ~/.dsh/skills/cdp-browser/extension → 报错
function resolveExtDir() {
  if (process.env.WB_CDP_EXT_DIR) {
    const dir = path.resolve(process.env.WB_CDP_EXT_DIR);
    if (!fs.existsSync(path.join(dir, "manifest.json"))) {
      throw new Error(
        "WB_CDP_EXT_DIR=" +
          dir +
          " 下没有 manifest.json（应指向含 manifest.json 的扩展根目录，不是 src/ 等子目录）",
      );
    }
    return dir;
  }
  const candidates = [
    path.join(SKILLS_DIR, "cdp", "extension"),
    path.join(SKILLS_DIR, "cdp-browser", "extension"),
    path.join(os.homedir(), ".dsh", "skills", "cdp-browser", "extension"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "manifest.json"))) return c;
  }
  throw new Error(
    "找不到 unpacked 扩展根目录。doctor 硬刷需要 WB_CDP_EXT_DIR 指向含 manifest.json 的目录" +
      "（候选：" +
      candidates.join(" | ") +
      "）",
  );
}

module.exports = {
  SKILL_ROOT,
  SKILLS_DIR,
  DATA_ROOT,
  BRIDGE_DIR,
  BRIDGE_FILE,
  resolveExtDir,
};
