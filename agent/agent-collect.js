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
const PORT_RANGE_START = Number(process.env.WB_AGENT_WS_START || 9521);
const PORT_RANGE_END = Number(process.env.WB_AGENT_WS_END || 9540);
// 50s：扩展端 Runtime.evaluate 有 6s 弹窗重试（最坏 2×timeout+6s，evaluate 类
// 命令扩展侧最坏 ~36-46s），CLI 上限须盖住扩展端最坏值（T-31）。
const CMD_TIMEOUT_MS = 50000;
const STATUS_TIMEOUT_MS = 1800;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function failReply(reply) {
  if (!reply || !reply.ok) {
    const error = new Error(reply?.error || "Extension command failed");
    error.code = reply?.code || "COMMAND_FAILED";
    throw error;
  }
  return reply.result;
}
function failEvaluation(result) {
  if (result?.exceptionDetails) {
    const error = new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "JavaScript execution failed",
    );
    error.code = "EVALUATION_FAILED";
    throw error;
  }
  return result;
}
function writeFailure(error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error.message || String(error),
      code: error.code || "COMMAND_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
}

function usage() {
  console.log(
    "用法:\n" +
      [
        "  agent-collect.js pair    (generate/show the local pairing token)",
        "  agent-collect.js list",
        "  agent-collect.js navigate <tabId> <url>",
        "  agent-collect.js cdp <tabId> <method> '<params-json>'",
        "  agent-collect.js run <tabId> '<js-expression>'   (Runtime.evaluate；默认 awaitPromise 等 promise 落定，--sync 不等)",
        "  agent-collect.js open <url>   （默认等 load 完成，返回 loaded；--nowait 跳过）",
        "  agent-collect.js open-frame <tabId> '<url-regex>'   （把匹配的子帧开成顶层标签——跨源 iframe 内容回退）",
        "  agent-collect.js close <tabId>",
        "  agent-collect.js attach <tabId>",
        "  agent-collect.js detach <tabId>",
        "  agent-collect.js diag",
        "  agent-collect.js capture <tabId> <url|reload|wait> [--duration ms] [--filter <re>] [--body-max kb] [--all]",
        "     （网络响应体捕获：触发导航/重载后抓该标签的 XHR/fetch 请求 + 响应体）",
        "  agent-collect.js capture-many <tabId:action> [<tabId:action> ...] [--duration ms] [--filter <re>] [--body-max kb] [--all]",
        "     （多标签并行网络捕获：不同 tab 各开一个 capture session，tabId 必须互不相同；action 同 capture）",
        "  agent-collect.js status",
        "     （有界健康探测：总时限 1.8 秒；多桥时逐个试连，任一桥可达即返回）",
        "  agent-collect.js doctor [--wait <ms>] [--force] [--dry]",
        "     （链路医生 + 多会话协调恢复，T-34：快查 → 礼貌等待 SW 重拨（探针端口/活桥，",
        "       默认 --wait 60s）→ 锁协调硬刷（data/maintenance.lock.json，同一时刻只有一个",
        "       会话执行 taskkill+清缓存+重启 Edge，排上的会话等锁释放后复查健康）。",
        "       多会话恢复统一走 doctor，不要各自手杀 Edge；--force 跳过等待，--dry 只打印计划）",
        "  agent-collect.js serve [session] [--shared]",
        "     （常驻 bridge：持有 WS 端口 + 保活扩展 SW，注册 data/bridges/<session>.json；",
        "       session 省略时自动生成并打印。one-shot 发现顺序：--session/WB_SESSION 指定桥 →",
        "       其它活桥（最新优先）→ 直连慢路径；多会话各起各的 serve 互不覆盖（T-33）。",
        "       --shared 额外写 data/bridge.json 兼容遗留脚本。Ctrl+C 退出）",
        "  agent-collect.js snapshot <tabId> [--max N]   （索引化动作空间：枚举可交互控件 [{i,tag,role,label}]）",
        "  agent-collect.js click-el <tabId> '<el-json>' （按 snapshot 条目点击；执行前重解析校验，漂移报 found:false）",
        "  agent-collect.js type-el <tabId> '<el-json>' <text> [--clear] （按条目键入，兼容受控组件）",
        '     （el-json 形如 {"i":3,"tag":"button","label":"搜索"}；免手写选择器，来自 snapshot）',
        "选项: --wait <ms>  --keep  --max <N>  --clear  --sync  --nowait  --client-id <id>  --trigger-js <expr>  --session <sid>  --shared  --force  --dry",
        "多会话: WB_SESSION=<sid>（本会话 one-shot 优先走 data/bridges/<sid>.json）；--keep 也会注册",
        "        为临时会话桥（注册表条目 + 允许多客户端），供同会话后续 one-shot 毫秒级复用",
      ].join("\n"),
  );
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

async function buildCaptureSessionResult(sendCmd, s, events, opts, bodyStore) {
  const { tabId, action, captureId } = s;
  const durationMs = opts.durationMs || 12000;

  // 合并事件：requestId -> 请求信息（buffer 已按 captureId 分流，无需再按 tabId 过滤）
  const reqs = new Map();
  for (const ev of events) {
    const p = ev.params || {};
    if (ev.method === "Network.requestWillBeSent") {
      reqs.set(p.requestId, {
        requestId: p.requestId,
        url: p.request && p.request.url,
        method: p.request && p.request.method,
        type: p.type || "",
        status: 0,
        mimeType: "",
        size: 0,
      });
    } else if (ev.method === "Network.responseReceived") {
      const r = reqs.get(p.requestId) || {
        requestId: p.requestId,
        url: p.response && p.response.url,
        method: "",
        type: "",
        status: 0,
        mimeType: "",
        size: 0,
      };
      r.status = p.response ? p.response.status : 0;
      r.mimeType = p.response ? p.response.mimeType : "";
      reqs.set(p.requestId, r);
    } else if (ev.method === "Network.loadingFinished") {
      const r = reqs.get(p.requestId);
      if (r) r.size = p.encodedDataLength || p.totalBytes || 0;
    }
  }

  // 过滤（与 doCapture 一致：默认只留 xhr/fetch 或 json；--all 全留；--filter 正则再筛）
  let cands = [...reqs.values()].filter(
    (c) => c.url && c.status && c.status < 500,
  );
  if (!opts.all) {
    cands = cands.filter(
      (c) =>
        String(c.type).toLowerCase() === "xhr" ||
        String(c.type).toLowerCase() === "fetch" ||
        /json/i.test(c.mimeType || ""),
    );
  }
  if (opts.filter) {
    let re;
    re = new RegExp(opts.filter, "i");
    if (re) cands = cands.filter((c) => re.test(c.url || ""));
  }
  cands.sort((a, b) => (b.size || 0) - (a.size || 0));
  cands = cands.slice(0, 40); // 与 doCapture 一致：最多 40 条

  // 逐条取响应体（body 截断到 bodyMaxKb，防输出膨胀）。窗口内已 eager 取到的
  // 直接用（T-30：窗口关完再取，顶层文档体可能已被浏览器回收）。
  const bodyLimit = (opts.bodyMaxKb || 200) * 1024;
  const decodeBody = (rawBody, base64Encoded) => {
    let body = base64Encoded
      ? Buffer.from(rawBody, "base64").toString("utf8")
      : rawBody;
    let bodyTruncated = false;
    if (body.length > bodyLimit) {
      body = body.slice(0, bodyLimit);
      bodyTruncated = true;
    }
    return { body, bodyTruncated };
  };
  const out = [];
  for (const c of cands) {
    let body = "";
    let bodyTruncated = false;
    let bodyError = "";
    const pre = bodyStore && bodyStore.get(captureId + ":" + c.requestId);
    if (pre) {
      ({ body, bodyTruncated } = decodeBody(pre.body, pre.base64Encoded));
    } else {
      try {
        const r = await sendCmd(
          {
            cmd: "cdp",
            args: {
              tabId,
              method: "Network.getResponseBody",
              params: { requestId: c.requestId },
            },
          },
          20000,
        );
        if (r.ok && r.result && typeof r.result.body === "string") {
          ({ body, bodyTruncated } = decodeBody(
            r.result.body,
            r.result.base64Encoded,
          ));
        } else if (!r.ok) {
          bodyError = r.error || "getResponseBody failed";
        }
      } catch (e) {
        bodyError = e.message;
      }
    }
    out.push({
      url: c.url,
      method: c.method,
      type: c.type,
      status: c.status,
      mimeType: c.mimeType,
      size: c.size,
      body,
      bodyTruncated,
      bodyError,
    });
  }

  return {
    tabId,
    action,
    durationMs,
    totalRequestsSeen: reqs.size,
    returned: out.length,
    requests: out,
    captureId,
  };
}

function bindAgentWs() {
  if (
    !Number.isInteger(PORT_RANGE_START) ||
    !Number.isInteger(PORT_RANGE_END) ||
    PORT_RANGE_START < 1 ||
    PORT_RANGE_END > 65535 ||
    PORT_RANGE_START > PORT_RANGE_END
  )
    throw new Error("Invalid WebSocket port range");
  async function attempt(port) {
    if (port > PORT_RANGE_END) throw new Error("No available bridge port");
    return new Promise((resolve, reject) => {
      const srv = new WebSocketServer({
        port,
        host: "127.0.0.1",
        maxPayload: 32 * 1024 * 1024,
      });
      srv.once("listening", () => resolve({ srv, port }));
      srv.once("error", (error) => {
        if (error.code === "EADDRINUSE") resolve(attempt(port + 1));
        else reject(error);
      });
    });
  }
  return attempt(PORT_RANGE_START);
}
function readBridge() {
  try {
    const b = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
    if (
      !Number.isInteger(b.pid) ||
      b.pid <= 0 ||
      !Number.isInteger(b.port) ||
      b.port <= 0 ||
      b.port > 65535
    )
      return null;
    try {
      process.kill(b.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return null;
      throw error;
    }
    return b;
  } catch (_) {
    return null;
  }
}
function writeBridge(port) {
  fs.mkdirSync(path.dirname(BRIDGE_FILE), { recursive: true });
  fs.writeFileSync(
    BRIDGE_FILE,
    JSON.stringify({ pid: process.pid, port, ts: Date.now() }) + "\n",
  );
}
function unlinkBridge() {
  try {
    const b = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
    if (b.pid === process.pid) fs.unlinkSync(BRIDGE_FILE);
  } catch (_) {}
}

// ---------------- 多会话桥注册表（T-33） ----------------
// 单文件 data/bridge.json 在多会话下的根本缺陷：多个 serve 互相覆盖（后写者赢），
// 赢家退出即删掉唯一发现记录，其它会话全跌回 60s 直连慢路径。注册表把发现记录
// 变成 data/bridges/<session>.json 一条一会话：互不踩踏、死条目自动清理、
// 会话可显式定位（--session / WB_SESSION），无定位时故障转移到任一活桥。
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function writeRegistryEntry(sid, port, dir = BRIDGE_DIR) {
  if (!SID_RE.test(sid))
    throw new Error("Invalid bridge session id " + JSON.stringify(sid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, sid + ".json"),
    JSON.stringify({ sid, pid: process.pid, port, ts: Date.now() }) + "\n",
  );
}
function unlinkRegistryEntry(sid, dir = BRIDGE_DIR) {
  const file = path.join(dir, sid + ".json");
  try {
    const e = JSON.parse(fs.readFileSync(file, "utf8"));
    if (e.pid === process.pid) fs.unlinkSync(file);
  } catch (_) {}
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
// 读单个条目文件：结构校验 + pid 活性；死条目就地清理（serve 被 SIGKILL 的残留）。
function readLiveEntry(file, fallbackSid, alive = pidAlive) {
  try {
    const e = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !Number.isInteger(e.pid) ||
      e.pid <= 0 ||
      !Number.isInteger(e.port) ||
      e.port < 1 ||
      e.port > 65535
    )
      return null;
    if (!alive(e.pid)) {
      try {
        fs.unlinkSync(file);
      } catch (_) {}
      return null;
    }
    return {
      sid: SID_RE.test(e.sid || "") ? e.sid : fallbackSid || "default",
      pid: e.pid,
      port: e.port,
      ts: Number(e.ts) || 0,
    };
  } catch (_) {
    return null;
  }
}
// 枚举全部活桥：注册表条目 + 遗留 data/bridge.json（sid "default"，老 daemon 兼容），
// 同端口去重（取更新者），按 ts 降序。
function listLiveBridges(
  dir = BRIDGE_DIR,
  legacyFile = BRIDGE_FILE,
  alive = pidAlive,
) {
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const e = readLiveEntry(path.join(dir, name), name.slice(0, -5), alive);
      if (e) out.push(e);
    }
  } catch (_) {}
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
// 逐个试连候选桥（连接层故障转移；命令尚未发出，安全）。全失败抛 NO_BRIDGE。
async function connectBridgeChain(candidates, token, opts, timeoutMs = 5000) {
  let lastError = null;
  for (const b of candidates) {
    try {
      const channel = await connectBridge(b, token, opts, timeoutMs);
      return { channel, bridge: b };
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(
    lastError
      ? "No live bridge reachable (" +
          candidates.length +
          " tried: " +
          lastError.message +
          ")"
      : "No live bridge discovery record",
  );
  error.code = "NO_BRIDGE";
  throw error;
}
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
function createChannel(socket, opts) {
  const pending = new Map();
  const eventsByCapture = new Map();
  const clientId = opts.clientId;
  function settle(id, error, reply) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    if (error) entry.reject(error);
    else entry.resolve(reply);
  }
  function onClose() {
    for (const id of [...pending.keys()])
      settle(
        id,
        new Error("Connection closed; dispatched operations may have executed"),
      );
  }
  function onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (message.type === "agent.result") {
      if (message.ok) settle(message.id, null, message);
      else {
        const error = new Error(message.error || "Extension command failed");
        error.code = message.code || "COMMAND_FAILED";
        settle(message.id, error);
      }
    } else if (message.type === "event.push" && message.clientId === clientId) {
      let events = eventsByCapture.get(message.captureId);
      if (!events) {
        events = [];
        eventsByCapture.set(message.captureId, events);
      }
      events.push(message);
      if (events.length > 2000) events.shift();
    }
  }
  socket.on("message", onMessage);
  socket.on("close", onClose);
  socket.on("error", onClose);
  function sendCmd(obj, timeoutMs = CMD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== 1) {
        reject(new Error("Connection is not open"));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        try {
          socket.send(JSON.stringify({ type: "cancel", id, clientId }));
        } catch (_) {}
        const error = new Error(
          "Command timed out; any operation already dispatched may have executed",
        );
        error.code = "COMMAND_TIMEOUT";
        settle(id, error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(
          JSON.stringify({
            type: "cmd",
            id,
            cmd: obj.cmd,
            args: obj.args,
            clientId,
            transientClient: opts.transientClient,
            timeoutMs,
            deadlineAt: Date.now() + timeoutMs,
          }),
        );
      } catch (error) {
        settle(id, error);
      }
    });
  }
  async function close(direct) {
    if (!opts.skipGracefulDisconnect && socket.readyState === 1) {
      const id = crypto.randomUUID();
      await new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, null, {}), 1500);
        pending.set(id, { resolve, reject: resolve, timer });
        try {
          socket.send(
            JSON.stringify({
              type: "client.disconnect",
              id,
              clientId,
              releaseLeases: opts.transientClient,
            }),
          );
        } catch (_) {
          settle(id, null, {});
        }
      });
    }
    for (const id of [...pending.keys()])
      settle(id, new Error("Channel closed"));
    socket.off("message", onMessage);
    socket.off("close", onClose);
    socket.off("error", onClose);
    if (socket.readyState < 2) socket.close();
    if (socket.readyState !== 3) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 200);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  return { sendCmd, eventsByCapture, close };
}
async function connectBridge(b, token, opts, timeoutMs = 5000) {
  const socket = new WebSocket("ws://127.0.0.1:" + b.port, {
    handshakeTimeout: timeoutMs,
  });
  socket.on("error", () => {});
  // Install proof listeners before open: the server sends its challenge immediately.
  try {
    await authenticateClient(socket, token, timeoutMs);
  } catch (error) {
    socket.terminate();
    error.code = "BRIDGE_AUTH_OR_CONNECT";
    throw error;
  }
  return createChannel(socket, opts);
}
async function connectDirect(token, opts) {
  const { srv, port } = await bindAgentWs();
  console.error(
    "[collect] Waiting for a paired extension on 127.0.0.1:" + port,
  );
  let timer;
  try {
    const socket = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Paired extension did not connect within " + opts.waitMs + "ms",
            ),
          ),
        opts.waitMs,
      );
      srv.on("connection", (peer, request) =>
        authenticateServer(peer, request, token, (role) => {
          if (role !== "extension") {
            peer.close(1008, "This endpoint accepts an extension only");
            return;
          }
          resolve(peer);
        }),
      );
    });
    clearTimeout(timer);
    // A one-shot endpoint owns one extension. Reject later connections.
    srv.removeAllListeners("connection");
    srv.on("connection", (peer) =>
      peer.close(1008, "An extension is already connected"),
    );
    const channel = createChannel(socket, opts);
    const closeChannel = channel.close;
    channel.close = async () => {
      await closeChannel(true);
      for (const peer of srv.clients) peer.terminate();
      await new Promise((resolve) => srv.close(resolve));
    };
    return channel;
  } catch (error) {
    clearTimeout(timer);
    for (const peer of srv.clients) peer.terminate();
    srv.close();
    throw error;
  }
}
async function triggerCapture(sendCmd, session, opts) {
  if (session.action === "reload")
    failReply(
      await sendCmd(
        {
          cmd: "cdp",
          args: { tabId: session.tabId, method: "Page.reload", params: {} },
        },
        20000,
      ),
    );
  else if (session.action !== "wait")
    failReply(
      await sendCmd({
        cmd: "navigate",
        args: { tabId: session.tabId, url: session.action, waitMs: 8000 },
      }),
    );
  if (opts.triggerJs)
    failEvaluation(
      failReply(
        await sendCmd({
          cmd: "cdp",
          args: {
            tabId: session.tabId,
            method: "Runtime.evaluate",
            params: {
              expression: opts.triggerJs,
              awaitPromise: true,
              returnByValue: true,
            },
          },
        }),
      ),
    );
}
async function doCaptureMany(sendCmd, pairs, opts, eventsByCapture) {
  const sessions = [];
  try {
    for (const pair of pairs) {
      const started = failReply(
        await sendCmd({
          cmd: "capture.start",
          args: {
            tabId: pair.tabId,
            domains: ["Network"],
            durationMs: opts.durationMs + 900000,
          },
        }),
      );
      sessions.push({ ...pair, captureId: started.captureId });
    }
    await Promise.all(
      sessions.map((session) => triggerCapture(sendCmd, session, opts)),
    );
    // eager 取响应体（T-30）：loadingFinished 一到就取，不等窗口关完——
    // 顶层 octet-stream 文档体关窗后取会报 No resource。取不到的回落旧路径。
    const bodyStore = new Map(); // "captureId:requestId" -> {body, base64Encoded}
    const inflight = [];
    const fetched = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < opts.durationMs) {
      for (const session of sessions) {
        for (const ev of eventsByCapture.get(session.captureId) || []) {
          if (ev.method !== "Network.loadingFinished") continue;
          const rid = ev.params && ev.params.requestId;
          const key = session.captureId + ":" + rid;
          if (!rid || fetched.has(key)) continue;
          fetched.add(key);
          inflight.push(
            sendCmd(
              {
                cmd: "cdp",
                args: {
                  tabId: session.tabId,
                  method: "Network.getResponseBody",
                  params: { requestId: rid },
                },
              },
              20000,
            )
              .then((r) => {
                if (r.ok && r.result && typeof r.result.body === "string") {
                  bodyStore.set(key, {
                    body: r.result.body,
                    base64Encoded: !!r.result.base64Encoded,
                  });
                }
              })
              .catch(() => {}),
          );
        }
      }
      await wait(Math.min(400, opts.durationMs));
    }
    await Promise.allSettled(inflight);
    return await Promise.all(
      sessions.map((session) =>
        buildCaptureSessionResult(
          sendCmd,
          session,
          eventsByCapture.get(session.captureId) || [],
          opts,
          bodyStore,
        ),
      ),
    );
  } finally {
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await sendCmd(
            {
              cmd: "capture.stop",
              args: { tabId: session.tabId, captureId: session.captureId },
            },
            5000,
          );
        } catch (_) {}
        eventsByCapture.delete(session.captureId);
      }),
    );
  }
}
async function executeCommand(channel, command, opts) {
  if (command.cmd === "capture")
    return (
      await doCaptureMany(
        channel.sendCmd,
        [command.args],
        opts,
        channel.eventsByCapture,
      )
    )[0];
  if (command.cmd === "capture-many")
    return doCaptureMany(
      channel.sendCmd,
      command.args.pairs,
      opts,
      channel.eventsByCapture,
    );
  const result = failReply(await channel.sendCmd(command));
  if (command.cmd === "cdp" && command.args?.method === "Runtime.evaluate")
    failEvaluation(result);
  return result;
}
function summarizeDiag(d) {
  return {
    wsAgents: d.wsAgents || [],
    nativeConnected: !!d.nativeConnected,
    captureSessions:
      typeof d.captureSessions === "number" ? d.captureSessions : null,
    lastLog: d.log?.at(-1) || null,
    lastWsLog: d.wsLog?.at(-1) || null,
  };
}
// 多会话（T-33）：逐个试连候选桥（会话桥优先），总时限仍为 STATUS_TIMEOUT_MS；
// 不回落 60s 直连路径。bridgeAlive 与 extension 可达性解耦（zhipin 探针只信
// bridgeAlive，避免把"扩展黑坑 T-23"误判为"桥死"而反复重启 serve）。
// probeStatusSnapshot 只做探测（doctor 复用）；runStatus 负责输出与退出码。
async function probeStatusSnapshot(opts) {
  const candidates = bridgeCandidates(opts);
  const token = readToken();
  let lastError = null;
  let connected = false;
  const started = Date.now();
  for (const b of candidates) {
    const remaining = STATUS_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) {
      lastError = lastError || new Error("Status deadline exceeded");
      break;
    }
    let channel;
    try {
      channel = await connectBridge(
        b,
        token,
        { ...opts, skipGracefulDisconnect: true },
        Math.max(300, remaining),
      );
      connected = true;
      const left = STATUS_TIMEOUT_MS - (Date.now() - started);
      if (left <= 0) throw new Error("Status deadline exceeded");
      const result = failReply(await channel.sendCmd({ cmd: "diag" }, left));
      return {
        ok: true,
        bridge: { pid: b.pid, port: b.port, sid: b.sid, alive: true },
        extension: summarizeDiag(result),
        fastPath: true,
      };
    } catch (error) {
      lastError = error;
    } finally {
      if (channel) await channel.close(false);
    }
  }
  const noBridge = !candidates.length;
  return {
    ok: false,
    bridge: null,
    extension: null,
    bridgeAlive: connected,
    fastPath: !noBridge,
    tried: candidates.map((b) => ({ sid: b.sid, port: b.port })),
    error: noBridge
      ? "No live bridge discovery record"
      : String((lastError && lastError.message) || "status deadline exceeded"),
    code: noBridge ? "NO_BRIDGE" : "STATUS_UNAVAILABLE",
  };
}
async function runStatus(opts) {
  const snap = await probeStatusSnapshot(opts);
  process.stdout.write(JSON.stringify(snap) + "\n");
  if (!snap.ok) process.exitCode = 1;
}

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
const MAINT_LOCK_TTL_MS = 180000;
function dataDir() {
  return path.dirname(BRIDGE_DIR);
} // data/
function maintenanceLockFile(dir = dataDir()) {
  return path.join(dir, "maintenance.lock.json");
}
function appendMaintenanceLog(line, dir = dataDir()) {
  try {
    fs.appendFileSync(
      path.join(dir, "maintenance.log"),
      JSON.stringify(
        Object.assign({ ts: Date.now(), pid: process.pid }, line),
      ) + "\n",
    );
  } catch (_) {}
}
async function acquireMaintenanceLock(timeoutMs = 30000, dir = dataDir()) {
  const file = maintenanceLockFile(dir);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // "wx"（O_CREAT|O_EXCL）原子创建：多会话并发时只有一个赢家。
      const fd = fs.openSync(file, "wx");
      fs.writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          ts: Date.now(),
          phase: "hard-refresh",
        }),
      );
      fs.closeSync(fd);
      return { file, acquired: true };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (_) {}
      const stale =
        !holder ||
        !Number.isInteger(holder.pid) ||
        !pidAlive(holder.pid) ||
        Date.now() - (holder.ts || 0) > MAINT_LOCK_TTL_MS;
      if (stale) {
        try {
          fs.unlinkSync(file);
        } catch (_) {}
        continue;
      } // 残留锁（持锁者被强杀）→ 窃取重试
      if (Date.now() >= deadline) return { file, acquired: false, holder };
      await wait(2000); // 活锁：等持锁者完成硬刷
    }
  }
}
function releaseMaintenanceLock(lock) {
  if (!lock || !lock.acquired) return;
  try {
    const cur = JSON.parse(fs.readFileSync(lock.file, "utf8"));
    if (cur.pid === process.pid) fs.unlinkSync(lock.file);
  } catch (_) {}
}
function findEdgeExe() {
  const candidates = [];
  if (process.env.WB_EDGE_EXE) candidates.push(process.env.WB_EDGE_EXE);
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const pf = process.env.PROGRAMFILES || "C:\\Program Files";
  for (const base of [pf86, pf])
    candidates.push(
      path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return "msedge.exe"; // 交给 PATH
}
function killAllEdge() {
  if (process.platform !== "win32")
    throw new Error(
      "doctor 硬刷目前仅支持 Windows（taskkill）；其它平台请按 T-17 手工恢复",
    );
  try {
    execSync("taskkill /f /im msedge.exe /t", {
      stdio: "ignore",
      timeout: 20000,
    });
  } catch (_) {} // 没有 Edge 也算成功
}
function clearSwCaches() {
  const ud =
    process.env.WB_EDGE_USER_DATA_DIR ||
    path.join(
      process.env.LOCALAPPDATA || ".",
      "Microsoft",
      "Edge",
      "User Data",
      "Default",
    );
  for (const sub of ["Service Worker", "Code Cache"]) {
    try {
      fs.rmSync(path.join(ud, sub), { recursive: true, force: true });
    } catch (_) {}
  }
}
// 解析要加载的扩展根目录并校验 manifest.json 存在（T-35 护栏）。
// 事故：某次把 --load-extension 指到了 extension/src（子目录，无清单）→
// Edge 启动报「无法加载扩展：清单文件丢失或不可读取」。launch 前必须确认
// 目标目录确实含 manifest.json，指错一层（src / 其它子目录）立即报错而非带病启动。
function resolveExtDir() {
  // 独立 skill 形态：扩展本体不在本 skill 内，默认路径由 paths.js 按候选推导
  // （WB_CDP_EXT_DIR 显式 → ../cdp/extension → ../cdp-browser/extension → 报错）。
  return _pathsResolveExtDir();
}
function launchEdge(exe) {
  const extDir = resolveExtDir();
  const child = spawn(exe, ["--load-extension=" + extDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return extDir;
}
// 宿主一个探针 WS 端口：扩展 SW 的 5s rescan 会把它当 agent 拨入，
// 认证通过且 role=extension 即证明 SW 活着（无需任何桥在运行）。
// 返回 { promise: {detected, ms, port?, error?}, portReady }。
function startProbeServer(token, waitMs) {
  let state = { done: false };
  let portReadyResolve;
  const portReady = new Promise((r) => {
    portReadyResolve = r;
  });
  const promise = (async () => {
    const t0 = Date.now();
    let srv;
    try {
      const bound = await bindAgentWs();
      srv = bound.srv;
      portReadyResolve(bound.port);
      const detected = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), waitMs);
        const finish = (v) => {
          if (!state.done) {
            state.done = true;
            clearTimeout(timer);
            resolve(v);
          }
        };
        srv.on("close", () => finish(false));
        srv.on("connection", (peer, request) => {
          authenticateServer(peer, request, token, (role) => {
            if (role === "extension") {
              finish(true);
              return;
            }
            try {
              peer.close(1008, "probe endpoint accepts an extension only");
            } catch (_) {}
          });
        });
      });
      return {
        detected,
        ms: Date.now() - t0,
        port: srv && srv.address && srv.address().port,
      };
    } catch (error) {
      return {
        detected: false,
        error: String((error && error.message) || error),
        ms: Date.now() - t0,
      };
    } finally {
      if (srv) {
        try {
          for (const p of srv.clients) p.terminate();
        } catch (_) {}
        try {
          await new Promise((resolve) => {
            srv.once("close", resolve);
            srv.close();
          });
        } catch (_) {}
      }
    }
  })();
  return { promise, portReady };
}
async function runDoctor(token, opts) {
  const say = (m) => console.error("[doctor] " + m);
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const t0 = Date.now();
  // 1) 快查
  let snap = await probeStatusSnapshot(opts);
  if (snap.ok) {
    say(
      "链路健康：桥 " +
        snap.bridge.sid +
        "@" +
        snap.bridge.port +
        " → 扩展在线，无需动作",
    );
    emit({
      ok: true,
      action: "none",
      via: "bridge",
      snapshot: snap,
      ms: Date.now() - t0,
    });
    return;
  }
  // 2) 礼貌等待：探针端口 + 活桥双通道接 SW 重拨（期间别的会话的恢复也会让它变好）
  if (!opts.force) {
    say(
      "扩展不在线（" +
        (snap.error || snap.code || "unknown") +
        "），礼貌等待 " +
        opts.waitMs +
        "ms：宿主探针端口接 SW 重拨，同时轮询活桥",
    );
    const probe = startProbeServer(token, opts.waitMs);
    let probeResult = null;
    probe.promise.then((r) => {
      probeResult = r;
    });
    for (;;) {
      await wait(5000);
      const s = await probeStatusSnapshot(opts);
      if (s.ok) {
        say("链路已恢复（活桥 " + s.bridge.sid + " 收到扩展），无需硬刷");
        emit({
          ok: true,
          action: "waited",
          via: "bridge",
          waitedMs: Date.now() - t0,
        });
        return;
      }
      if (probeResult && probeResult.detected) {
        say(
          "扩展 SW 已重拨探针端口（" +
            (probeResult.port || "?") +
            "），无需硬刷",
        );
        emit({
          ok: true,
          action: "waited",
          via: "probe",
          waitedMs: Date.now() - t0,
        });
        return;
      }
      if (Date.now() - t0 >= opts.waitMs) break;
    }
    say("礼貌等待超时（" + opts.waitMs + "ms），进入协调硬刷");
  }
  if (opts.dry) {
    console.error(
      "[doctor] dry-run：将执行 taskkill /f /im msedge.exe + 清默认 profile 的 Service Worker/Code Cache + 启动 msedge --load-extension",
    );
    emit({
      ok: false,
      action: "dry-run",
      plan: { kill: "msedge.exe", clearCaches: true, relaunch: true },
    });
    process.exitCode = 2;
    return;
  }
  // 3) 协调硬刷：锁内的会话独占 kill+清缓存+重启；排上的会话等锁释放后复查
  const lock = await acquireMaintenanceLock(opts.waitMs);
  if (!lock.acquired) {
    const s = await probeStatusSnapshot(opts);
    if (s.ok) {
      say(
        "另一个会话的硬刷已生效（holder pid=" +
          lock.holder.pid +
          "），链路恢复",
      );
      emit({
        ok: true,
        action: "waited",
        via: "concurrent-repair",
        snapshot: s,
      });
      return;
    }
    say(
      "另一个会话正在恢复（holder pid=" +
        (lock.holder && lock.holder.pid) +
        "）且链路仍未好；稍后重试，或 --force 跳过礼貌等待",
    );
    emit({
      ok: false,
      action: "lock-held",
      holder: lock.holder,
      error: "another session holds the maintenance lock",
    });
    process.exitCode = 1;
    return;
  }
  try {
    appendMaintenanceLog({
      phase: "hard-refresh-start",
      reason: snap.error || snap.code || "extension offline",
    });
    killAllEdge();
    await wait(2000); // 等进程退干净（profile 锁释放）
    clearSwCaches();
    const extDir = launchEdge(findEdgeExe());
    appendMaintenanceLog({ phase: "edge-relaunched", extDir });
    say("已杀 Edge + 清 SW/Code Cache + 带扩展重启，等待扩展上线（≤90s）");
    const hardProbe = startProbeServer(token, 90000);
    let probeResult = null;
    hardProbe.promise.then((r) => {
      probeResult = r;
    });
    let ok = false;
    while (Date.now() - t0 < 150000) {
      await wait(5000);
      if (probeResult && probeResult.detected) {
        ok = true;
        break;
      }
      const s = await probeStatusSnapshot(opts);
      if (s.ok) {
        ok = true;
        break;
      }
    }
    if (ok) {
      appendMaintenanceLog({ phase: "hard-refresh-ok" });
      say("硬刷完成：扩展已上线，链路恢复");
      emit({ ok: true, action: "hard-refresh", ms: Date.now() - t0 });
    } else {
      appendMaintenanceLog({ phase: "hard-refresh-timeout" });
      say(
        "硬刷超时：扩展仍未上线；请手工按 T-17 配方复查（浏览器是否起、扩展是否加载）",
      );
      emit({
        ok: false,
        action: "hard-refresh",
        error: "extension did not come back within hard-refresh budget",
      });
      process.exitCode = 1;
    }
  } finally {
    releaseMaintenanceLock(lock);
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
