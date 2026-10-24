"use strict";
// 版本单一来源校验：extension/manifest.json 与 package.json 必须一致。
//
// 为什么需要：manifest 决定商店里的版本号，package.json 决定仓库里看起来的版本；
// 两处手改时很容易漏掉一处，出现「商店是 0.15.2、README/包元数据还是 0.15.1」的漂移。
// 接进 npm test 后，漏改任何一处都会当场失败。
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"),
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

if (!manifest.version || !pkg.version) {
  console.error("版本号缺失：manifest.version 或 package.json version 为空");
  process.exit(1);
}
if (manifest.version !== pkg.version) {
  console.error(
    "版本不一致：extension/manifest.json=" +
      manifest.version +
      "，package.json=" +
      pkg.version,
  );
  process.exit(1);
}
console.log("ALL-VERSION-OK (" + manifest.version + ")");
