"use strict";
// 命令表与实现的漂移守卫。
//
// 背景：usage 曾经是手写的，和 buildCmd 的 switch 各写一遍，结果真的漂了
// ——`setfile` 有实现但没进 usage，用户看不见这条命令。本测试把「表」和
// 「实现」钉在一起：任何一边新增/改名命令而另一边没跟上，立刻失败。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { COMMANDS, NAMES, renderUsage } = require("./commands");

const cliSrc = fs.readFileSync(path.join(__dirname, "cli.js"), "utf8");
const implemented = [...cliSrc.matchAll(/case "([a-z0-9-]+)":/g)].map((m) => m[1]);

const missingInTable = implemented.filter((n) => !NAMES.includes(n));
const missingInCode = NAMES.filter((n) => !implemented.includes(n));

assert.deepStrictEqual(
  missingInTable,
  [],
  "buildCmd 实现了但命令表里没有（usage 会看不见）：" + missingInTable.join(", "),
);
assert.deepStrictEqual(
  missingInCode,
  [],
  "命令表里有但 buildCmd 没实现：" + missingInCode.join(", "),
);

// 重名会让 usage 出现两条、parse 时也说不清谁优先。
assert.strictEqual(new Set(NAMES).size, NAMES.length, "命令表里有重名");

// 每条命令都必须出现在渲染结果里，且渲染不抛错。
const text = renderUsage();
for (const command of COMMANDS) {
  assert.ok(
    text.includes("agent-collect.js " + command.lines[0]),
    "usage 里缺少命令：" + command.name,
  );
}
assert.ok(text.startsWith("用法:"), "usage 开头固定为「用法:」");
assert.ok(text.includes("--session <sid>"), "usage 必须列出 --session");

console.log("ALL-COMMANDS-OK (" + NAMES.length + " commands, table === implementation)");
