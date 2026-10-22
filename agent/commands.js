"use strict";
// 命令清单的唯一来源。
//
// 之前 usage() 手写一份、buildCmd 的 switch 实现一份、SKILL.md 再写一份，三处会各自漂移
// （实际发生过：文档写 bridge 24 用例、真实 28；pair 有实现但早期文档没列）。
// 现在命令名与用法只在这里定义，usage 由它渲染；后续参数校验也从这里取元数据。
//
// 字段：
//   name   —— 命令名（与 buildCmd 的 switch 分支一一对应）
//   lines  —— 第 1 行为调用形状，其余为缩进说明行
//   writes —— 是否会产生副作用（供未来做只读校验/权限分级用）

const COMMANDS = [
  { name: "pair", lines: ["pair    (generate/show the local pairing token)"] },
  { name: "list", lines: ["list"] },
  { name: "navigate", lines: ["navigate <tabId> <url>"] },
  { name: "cdp", lines: ["cdp <tabId> <method> '<params-json>'"] },
  {
    name: "run",
    lines: [
      "run <tabId> '<js-expression>'   (Runtime.evaluate；默认 awaitPromise 等 promise 落定，--sync 不等)",
    ],
  },
  {
    name: "open",
    lines: ["open <url>   （默认等 load 完成，返回 loaded；--nowait 跳过）"],
  },
  {
    name: "open-frame",
    lines: [
      "open-frame <tabId> '<url-regex>'   （把匹配的子帧开成顶层标签——跨源 iframe 内容回退）",
    ],
  },
  { name: "close", lines: ["close <tabId>"] },
  {
    name: "setfile",
    lines: [
      "setfile <tabId> <selector> <file-path>   （给 input[type=file] 塞本地文件，走 CDP DOM.setFileInputFiles）",
    ],
  },
  { name: "attach", lines: ["attach <tabId>"] },
  { name: "detach", lines: ["detach <tabId>"] },
  { name: "diag", lines: ["diag"] },
  {
    name: "capture",
    lines: [
      "capture <tabId> <url|reload|wait> [--duration ms] [--filter <re>] [--body-max kb] [--all]",
      "（网络响应体捕获：触发导航/重载后抓该标签的 XHR/fetch 请求 + 响应体）",
    ],
  },
  {
    name: "capture-many",
    lines: [
      "capture-many <tabId:action> [<tabId:action> ...] [--duration ms] [--filter <re>] [--body-max kb] [--all]",
      "（多标签并行网络捕获：不同 tab 各开一个 capture session，tabId 必须互不相同；action 同 capture）",
    ],
  },
  {
    name: "status",
    lines: [
      "status",
      "（有界健康探测：总时限 1.8 秒；多桥时逐个试连，任一桥可达即返回）",
    ],
  },
  {
    name: "doctor",
    lines: [
      "doctor [--wait <ms>] [--force] [--dry]",
      "（链路医生 + 多会话协调恢复，T-34：快查 → 礼貌等待 SW 重拨（探针端口/活桥，",
      "  默认 --wait 60s）→ 锁协调硬刷（data/maintenance.lock.json，同一时刻只有一个",
      "  会话执行 taskkill+清缓存+重启 Edge，排上的会话等锁释放后复查健康）。",
      "  多会话恢复统一走 doctor，不要各自手杀 Edge；--force 跳过等待，--dry 只打印计划）",
    ],
  },
  {
    name: "serve",
    lines: [
      "serve [session] [--shared]",
      "（常驻 bridge：持有 WS 端口 + 保活扩展 SW，注册 data/bridges/<session>.json；",
      "  session 省略时自动生成并打印。one-shot 发现顺序：--session/WB_SESSION 指定桥 →",
      "  其它活桥（最新优先）→ 直连慢路径；多会话各起各的 serve 互不覆盖（T-33）。",
      "  --shared 额外写 data/bridge.json 兼容遗留脚本。Ctrl+C 退出）",
    ],
  },
  {
    name: "snapshot",
    lines: [
      "snapshot <tabId> [--max N]   （索引化动作空间：枚举可交互控件 [{i,tag,role,label}]）",
    ],
  },
  {
    name: "click-el",
    lines: [
      "click-el <tabId> '<el-json>' （按 snapshot 条目点击；执行前重解析校验，漂移报 found:false）",
    ],
  },
  {
    name: "type-el",
    lines: [
      "type-el <tabId> '<el-json>' <text> [--clear] （按条目键入，兼容受控组件）",
      '（el-json 形如 {"i":3,"tag":"button","label":"搜索"}；免手写选择器，来自 snapshot）',
    ],
  },
];

const FOOTER = [
  "选项: --wait <ms>  --keep  --max <N>  --clear  --sync  --nowait  --client-id <id>  --trigger-js <expr>  --session <sid>  --shared  --force  --dry",
  "多会话: WB_SESSION=<sid>（本会话 one-shot 优先走 data/bridges/<sid>.json）；--keep 也会注册",
  "        为临时会话桥（注册表条目 + 允许多客户端），供同会话后续 one-shot 毫秒级复用",
];

const NAMES = COMMANDS.map((c) => c.name);

function renderUsage(binName = "agent-collect.js") {
  const lines = ["用法:"];
  for (const command of COMMANDS) {
    lines.push("  " + binName + " " + command.lines[0]);
    for (const extra of command.lines.slice(1)) lines.push("     " + extra);
  }
  return lines.concat(FOOTER).join("\n");
}

module.exports = { COMMANDS, FOOTER, NAMES, renderUsage };
