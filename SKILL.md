---
name: synapse
description: 驱动已运行、已登录的 Chrome/Edge（本机回环 WebSocket + MV3 扩展 chrome.debugger 全量 CDP 透传）。用于读渲染 DOM、点选/输入、跑页内 JS、捕获页面自身 XHR/fetch 响应、复用登录态做网页自动化。无 --remote-debugging-port、无 native messaging、无服务端。触发词：synapse、CDP、驱动浏览器、点选元素、捕获接口响应、复用登录态。
---

# Synapse

**扩展是控制面，`agent/` 是 agent 侧。** 扩展（MV3 service worker）附到标签上做
`chrome.debugger` 全量 CDP 透传，主动拨入本机回环 WS server；agent 侧起 server、
发命令、取结果。浏览器必须是**已经开着的**——登录态就在里面。

## 拓扑

```
你的程序 / agent（agent/agent-collect.js）
      │  127.0.0.1:9521-9540 起 WS server
      ▼  ◄── 扩展 SW 主动拨入（连入即保活；掉线自动重拨）
扩展（extension/src/background.js → chrome.debugger.attach）
      ▼
你活着的浏览器标签（登录态在里面）
```

## 分层边界

判定标准：**浏览器要加载的 → 扩展层；`require` 进来的 → agent 层。**

| 层 | 位置 | 内容 |
|---|---|---|
| 扩展层 | `extension/src/` | manifest、SW、`chrome.debugger`、页内注入、`Input.dispatch*` 物理输入、浏览器侧 `ws-auth.js` |
| Agent 层 | `agent/` | CLI、桥发现/注册表/故障转移、`bridge-router`（tab FIFO + clientId 租约）、`bridge-auth`、`paths`、`doctor`、测试 |

两侧各有一份 `ws-auth.js` 是唯一合理的重复（浏览器不能 `require` node 模块），由
`extension/src/test-ws-auth.js` 的互通测试锁住一致性。

`cdp` skill 里的 `extension/native-host/` 是本仓库 `agent/` 的生成副本（历史路径，
不改 cdp 的引用）：改源 → `npm run sync-cdp`；漂移用 `npm run check-drift` 查。

## 用法

```powershell
# 起常驻桥（一条会话一个；注册 data/bridges/<session>.json）
node agent/agent-collect.js serve mysession

# one-shot：带 --session 走自己的桥（毫秒级）
node agent/agent-collect.js status --session mysession
node agent/agent-collect.js list   --session mysession
node agent/agent-collect.js open <url> --session mysession
node agent/agent-collect.js run <tabId> '<js>' --session mysession
node agent/agent-collect.js cdp <tabId> <Domain.method> '<params-json>' --session mysession
node agent/agent-collect.js snapshot <tabId> [--max N] --session mysession
node agent/agent-collect.js click-el <tabId> '{"i":18,"tag":"a","role":"","label":"搜索"}' --session mysession
node agent/agent-collect.js type-el <tabId> '{"i":3,"tag":"input","role":""}' <text> [--clear] --session mysession
node agent/agent-collect.js capture <tabId> <url|reload|wait> --duration <ms> [--filter <re>] [--all]
node agent/agent-collect.js doctor [--wait <ms>] [--force] [--dry]
```

`--session <sid>` 与 `WB_SESSION` 等价；**Windows 下用 `--session`**。

## 发现顺序与故障转移

`WB_BRIDGE_FILE`（遗留独占）→ 会话桥（`--session` / `WB_SESSION`）→ 其它活桥
（`ts` 降序）→ 遗留 `data/bridge.json` → 全失败才回落 60s 直连慢路径。
daemon 被强杀留下的死条目，下次发现时自动清理。

## 健康与恢复

- `status`：<2s 有界探活；无活桥立即 `NO_BRIDGE`，不等不回落。
- 桥活但扩展黑坑（MV3 SW 挂起）：`bridgeAlive:true + extension:null` → 跑 `doctor`。
- `doctor`：快查 → 礼貌等待 60s（探针端口 / 活桥 SW 重拨）→ 维护锁内协调硬刷
  （taskkill + 清 SW/Code Cache + `--load-extension` 重启）。
  **多会话统一走 doctor，不要各自手杀浏览器。**

## 测试

```powershell
npm test     # tablock(8) + background(27) + bridge(28)，全部浏览器无关
npm run verify
```

## 路径

全部走 `agent/paths.js`（`WB_DATA_DIR` / `WB_BRIDGE_DIR` / `WB_BRIDGE_FILE` /
`WB_CDP_EXT_DIR` / `WB_EDGE_EXE` / `WB_AGENT_WS_START|END`）。详见 README 的
「路径配置」表。
