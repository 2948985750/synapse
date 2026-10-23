"use strict";
// 构建商店可上传的 dist（manifest 在包根）：只含扩展运行所需文件，
// 排除开发件（test-*）与打包工具本身（store/）。agent 侧桥在另一个仓库，不在本包内。
// 产物：extension/store/dist/synapse/（随后由 PowerShell Compress-Archive 打 zip）。
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..");
const DIST = path.join(__dirname, "dist", "synapse");

// 需要打包进 zip 的相对路径（manifest 位于根）。图标只收 16/32/48/128（512 用于商店页展示，不入包）。
const INCLUDE = [
  "manifest.json",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "src/background.js",
  "src/content.js",
  "src/tablock.js",
  "src/ws-auth.js",
  "src/sidepanel/index.html",
  "src/sidepanel/panel.js",
];

// 清理旧的 dist
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const missing = [];
for (const rel of INCLUDE) {
  const from = path.join(EXT, rel);
  const to = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (!fs.existsSync(from)) { missing.push(rel); continue; }
  fs.copyFileSync(from, to);
}
if (missing.length) {
  console.error("缺少必需文件，构建中止：\n  " + missing.join("\n  "));
  process.exit(1);
}

// 校验 manifest 合法 + 相对引用都存在
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
const refs = [...Object.values(manifest.icons || {}), ...Object.values((manifest.action || {}).default_icon || {})];
for (const ref of new Set(refs)) {
  if (!fs.existsSync(path.join(DIST, ref))) {
    console.error("manifest 引用的图标缺失：" + ref);
    process.exit(1);
  }
}
// 确认没有漏打包测试件
for (const f of fs.readdirSync(DIST, { recursive: true })) {
  if (/test-.*\.js$/.test(f)) {
    console.error("dist 里混入了不应发布的内容：" + f);
    process.exit(1);
  }
}
console.log("dist 就绪：" + DIST);
console.log("包含 " + fs.readdirSync(DIST, { recursive: true }).length + " 个条目。用 PowerShell 打 zip：");
console.log('  Compress-Archive -Path "dist\\synapse\\*" -DestinationPath "synapse-' + manifest.version + '.zip"');
