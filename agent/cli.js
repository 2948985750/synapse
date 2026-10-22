"use strict";
// cli：参数解析与命令构造（纯函数，不碰网络/文件，便于单测）。
const { renderUsage } = require("./commands");

function usage() {
  console.log(renderUsage());
  process.exit(1);
}

function parseArgs(argv) {
  const rest = [];
  // 默认 60s：MV3 service worker 空闲 30s 会挂起，唤醒只靠 30s 的
  // chrome.alarms 心跳。若浏览器处于空闲态，扩展最多 ~30s 才重新探一次
  // agent 端口，所以等待必须跨越至少一个完整心跳周期，默认取 60s。
  // 浏览器近期活跃（SW 存活）时其实 2~5s 就连上，不会真等 60s。
  let waitMs = 60000;
  let keep = false;
  // capture 选项
  let durationMs = 12000;
  let filter = "";
  let bodyMaxKb = 200;
  let all = false;
  // snapshot/click-el/type-el 选项
  let snapMax = 50;
  let clear = false;
  let triggerJs = "";
  let clientId = process.env.WB_CLIENT_ID || "";
  // --sync：run 不带 awaitPromise（fire-and-forget，副作用用 window 寄存后二次 run 查询）。
  // 场景：await 一个永不落定的 promise（如 401 认证框挂着的 fetch）会卡到 CDP 超时（T-30）。
  let sync = false;
  // --nowait：open/navigate 不等 load（扩展端默认等 15s，T-30 修复）。
  let nowait = false;
  // 多会话（T-33）：--session <sid> 指定/偏好桥注册表条目（等价 env WB_SESSION）；
  // --shared（仅 serve）额外写 data/bridge.json 兼容遗留脚本。
  // doctor（T-34）：--force 跳过礼貌等待直接进硬刷协调；--dry 只打印硬刷计划。
  let session = "";
  let shared = false;
  let force = false;
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wait") waitMs = Number(argv[++i]) || waitMs;
    else if (a === "--keep") keep = true;
    else if (a === "--duration") durationMs = Number(argv[++i]) || durationMs;
    else if (a === "--filter") filter = argv[++i] || "";
    else if (a === "--body-max") bodyMaxKb = Number(argv[++i]) || bodyMaxKb;
    else if (a === "--all") all = true;
    else if (a === "--max") snapMax = Number(argv[++i]) || snapMax;
    else if (a === "--clear") clear = true;
    else if (a === "--trigger-js") triggerJs = argv[++i] || "";
    else if (a === "--client-id") clientId = argv[++i] || "";
    else if (a === "--sync") sync = true;
    else if (a === "--nowait") nowait = true;
    else if (a === "--session") session = argv[++i] || "";
    else if (a === "--shared") shared = true;
    else if (a === "--force") force = true;
    else if (a === "--dry") dry = true;
    else rest.push(a);
  }
  return {
    rest,
    waitMs,
    keep,
    durationMs,
    filter,
    bodyMaxKb,
    all,
    snapMax,
    clear,
    triggerJs,
    clientId,
    sync,
    nowait,
    session,
    shared,
    force,
    dry,
  };
}

function buildCmd(rest, opts = {}) {
  const snapMax = opts.snapMax || 50;
  const clear = !!opts.clear;
  const [cmd, ...args] = rest;
  switch (cmd) {
    case "list":
      return { cmd: "tabs" };
    case "navigate": {
      const [tabId, url] = args;
      if (!tabId || !url) usage();
      return {
        cmd: "navigate",
        args: {
          tabId: Number(tabId),
          url,
          waitMs: opts.nowait ? 0 : undefined,
        },
      };
    }
    case "cdp": {
      const [tabId, method, paramsJson] = args;
      if (!tabId || !method) usage();
      return {
        cmd: "cdp",
        args: {
          tabId: Number(tabId),
          method,
          params: paramsJson ? JSON.parse(paramsJson) : {},
        },
      };
    }
    case "run": {
      const [tabId, expr] = args;
      if (!tabId || !expr) usage();
      return {
        cmd: "cdp",
        args: {
          tabId: Number(tabId),
          method: "Runtime.evaluate",
          params: {
            expression: expr,
            returnByValue: true,
            awaitPromise: !opts.sync,
          },
        },
      };
    }
    case "attach":
      return { cmd: "attach", args: { tabId: Number(args[0]) } };
    case "detach":
      return { cmd: "detach", args: { tabId: Number(args[0]) } };
    case "open":
      return {
        cmd: "open",
        args: { url: args[0], waitMs: opts.nowait ? 0 : undefined },
      };
    case "open-frame": {
      const [tabId, urlPattern] = args;
      if (!tabId || !urlPattern) usage();
      return { cmd: "open-frame", args: { tabId: Number(tabId), urlPattern } };
    }
    case "close":
      return { cmd: "close", args: { tabId: Number(args[0]) } };
    case "diag":
      return { cmd: "diag" };
    case "status":
      // 快路径健康探测：逐个试连候选桥（详见 main / runViaBridge 里的 status 分支）
      return { cmd: "status" };
    case "doctor":
      // 链路医生 + 多会话协调恢复（T-34）：快查 → 礼貌等待 SW 重拨 → 锁协调硬刷。
      // 多会话统一走它做恢复，不要各自 taskkill Edge（浏览器反复关开重的来源）。
      return { cmd: "doctor" };
    case "pair":
      return { cmd: "pair" };
    case "serve": {
      // 常驻 bridge daemon：起 WS server 并保活，注册 data/bridges/<session>.json
      // 供 one-shot 发现（T-33）；[session] 位置参数 = 会话名（多会话各占一条目，互不覆盖），
      // 省略则自动生成并打印（--shared 另写 data/bridge.json 兼容遗留脚本）。
      const [sid] = args;
      return { cmd: "serve", args: { sid: sid || "" } };
    }
    case "capture": {
      const [tabId, action] = args;
      if (!tabId || !action) usage();
      // action: 一个 URL（触发导航并捕获）| "reload"（重载当前页并捕获）| "wait"（不触发，只捕获窗口内已发生的请求）
      return { cmd: "capture", args: { tabId: Number(tabId), action } };
    }
    case "setfile": {
      const [tabId, selector, file] = args;
      if (!tabId || !selector || !file) usage();
      return {
        cmd: "setfile",
        args: { tabId: Number(tabId), selector, files: [file] },
      };
    }
    case "snapshot": {
      // 索引化动作空间（jev 引入）：枚举页面可交互控件为紧凑索引
      // [{i, tag, role, label}]，后续 click-el/type-el 按条目定位，免手写选择器。
      const [tabId] = args;
      if (!tabId) usage();
      return { cmd: "snapshot", args: { tabId: Number(tabId), max: snapMax } };
    }
    case "click-el": {
      // <tabId> <el-json>：el-json = snapshot 返回条目 {"i":3,"tag":"button","label":"搜索"}
      // 扩展端执行前重解析校验（索引越界/label 漂移 → found:false 不执行）。
      const [tabId, elJson] = args;
      if (!tabId || !elJson) usage();
      let el;
      try {
        el = JSON.parse(elJson);
      } catch (_) {
        el = null;
      }
      if (!el || typeof el.i !== "number") usage();
      return { cmd: "click-el", args: { tabId: Number(tabId), el } };
    }
    case "type-el": {
      // <tabId> <el-json> <text> [--clear]：键入文本（native value setter + input/change
      // 事件，兼容受控组件）；--clear 先清空。
      const [tabId, elJson, text] = args;
      if (!tabId || !elJson || text === undefined) usage();
      let el;
      try {
        el = JSON.parse(elJson);
      } catch (_) {
        el = null;
      }
      if (!el || typeof el.i !== "number") usage();
      return {
        cmd: "type-el",
        args: { tabId: Number(tabId), el, text, clear },
      };
    }
    case "capture-many": {
      // <tabId:action> pairs；action 同 capture（URL | reload | wait）；
      // tabId 必须互不相同（扩展约束：同 tab + 同 client 的 capture session 互斥）
      if (!args.length) usage();
      const pairs = [];
      const seenTabs = new Set();
      for (const spec of args) {
        // 第一个冒号分隔 tabId 与 action（URL 里自带的冒号不受影响）
        const i = spec.indexOf(":");
        if (i <= 0) {
          console.error(
            "[collect] capture-many: 无效 pair '" +
              spec +
              "'（格式 <tabId:action>，如 123:reload）",
          );
          process.exit(1);
        }
        const tabId = Number(spec.slice(0, i));
        if (!Number.isInteger(tabId) || tabId <= 0) {
          console.error(
            "[collect] capture-many: tabId 必须是正整数，收到 '" +
              spec.slice(0, i) +
              "'",
          );
          process.exit(1);
        }
        const action = spec.slice(i + 1);
        if (!action) {
          console.error(
            "[collect] capture-many: action 不能为空 '" + spec + "'",
          );
          process.exit(1);
        }
        if (seenTabs.has(tabId)) {
          console.error(
            "[collect] capture-many: 重复 tab " +
              tabId +
              "（同 tab 同 client 的 capture session 互斥，请改用不同标签）",
          );
          process.exit(1);
        }
        seenTabs.add(tabId);
        pairs.push({ tabId, action });
      }
      return { cmd: "capture-many", args: { pairs } };
    }
    default:
      usage();
  }
}

function validateOptions(opts) {
  for (const name of ["waitMs", "durationMs", "bodyMaxKb", "snapMax"])
    if (!Number.isFinite(opts[name]) || opts[name] <= 0)
      throw new Error(name + " must be a positive number");
  if (opts.filter) new RegExp(opts.filter, "i");
  if (
    opts.clientId &&
    (typeof opts.clientId !== "string" || opts.clientId.length > 128)
  )
    throw new Error("clientId must be at most 128 characters");
}

module.exports = { usage, parseArgs, buildCmd, validateOptions };
