# Synapse — MV3 扩展

让**本机的 AI 编程代理**驱动你**已登录**的 Chrome/Edge：读渲染 DOM、驱动输入、
捕获页面自身 API 响应、跑任意页内 JS。

本仓库**只含浏览器扩展**。agent 侧（CLI + 回环 WebSocket 桥）在独立仓库
**synapse-skill**，两者通过 127.0.0.1 上的 WebSocket 通信。

无 `--remote-debugging-port`、无 native messaging、无服务端、无遥测。

```
agent 侧（synapse-skill 仓库的 agent/）
      │  本机回环起 WS server（127.0.0.1:9521-9540）
      ▼  ◄── 扩展 service worker 主动拨入（保持 SW 存活）
扩展（本仓库：src/background.js，chrome.debugger.attach → CDP 全透传）
      ▼
你活着的浏览器（登录态在里面）
```

## 目录

| 路径 | 内容 |
|---|---|
| `extension/manifest.json` | MV3 清单（名称、权限、service worker 入口） |
| `extension/src/background.js` | 接线层：装配下面这些 manager、WS 拨入、sidePanel RPC、生命周期监听 |
| `extension/src/tablock.js` | 同 tab 串行化（FIFO + 超时） |
| `extension/src/lib/page-actions.js` | 页内动作空间表达式（snapshot 枚举 / click / type），纯字符串、不碰 `chrome.*` |
| `extension/src/lib/cdp-transport.js` | CDP 传输层：`sendCommand` 硬超时、`Runtime.evaluate` 弹窗重试、锁预算、等加载完成 |
| `extension/src/lib/capture-store.js` | capture 会话：domain 复用判断、定时停止、事件定向推送 |
| `extension/src/lib/attach.js` | attach 状态：`tabs`/`targetByTab`、attach/detach、收养 SW 重启后残留的 debugger 会话 |
| `extension/src/lib/leases.js` | 租约与 tab 锁：client 租约集合、`hasTabLease`、`beginCommand`、`withTabLock` |
| `extension/src/lib/commands.js` | 命令执行器：`tabs`/`open`/`snapshot`/`click-el`/`capture.*`/`cdp`/`run` 等全部命令（依赖注入） |
| `extension/src/ws-auth.js` | 浏览器侧 HMAC 挑战/证明（协议 `wb-cdp-ws/2`） |
| `extension/src/content.js` | 页内辅助（`isTrusted` 事件、shadow DOM 穿透） |
| `extension/src/sidepanel/` | 侧边栏 UI（标签、诊断、CDP 调用） |
| `extension/icons/` | 商店图标 |
| `build/` | 构建脚本（`build-store.js`、`gen-icons.js`），产物在 `build/dist/` |
| `extension/store/` | 商店文案与隐私页（`LISTING.md`、`privacy-policy.html`） |

## 本机加载（unpacked）

1. `edge://extensions`（或 `chrome://extensions`）→ 打开开发者模式 →
   「加载已解压的扩展程序」→ 选 **`extension/`** 目录。
2. 到 [synapse-skill](https://github.com/2948985750/synapse-skill) 仓库起桥：
   `node agent/agent-collect.js serve mysession`。
3. 侧边栏里能看到桥状态即接通。

## 发布到商店

```powershell
npm run build:store     # = node build/build-store.js
```

生成 `build/dist/synapse/`（manifest 在包根，不含测试件；agent 侧代码本来就不在本仓库）。
需要上传时再自行打 zip 传到 [aka.ms/edgedevcenter](https://aka.ms/edgedevcenter)。
列表文案与审核问答见 `extension/store/LISTING.md`。

## 权限与隐私

| 权限 | 为什么需要 |
|---|---|
| `debugger` | 全量 CDP 透传的唯一途径（替代 `--remote-debugging-port`） |
| `tabs` / `tabGroups` | 列出与组织可驱动的标签 |
| `sidePanel` | 状态与 CDP 调用 UI |
| `storage` | 诊断日志（仅本地） |
| `alarms` | MV3 service worker 保活（30s 心跳，掉线自动重拨） |
| `<all_urls>` | 要在任意站点上执行页内 JS（用户主动触发） |

扩展**只与 `127.0.0.1` 上的本机桥通信**，不向外发数据、不带遥测。

## 鉴权与信任模型

扩展与 agent 两侧写死同一枚固定标识（`src/ws-auth.js` 的 `DEFAULT_TOKEN`，
agent 仓库里是同值），连接时做双向 HMAC 挑战/应答。没有配对码、没有 UI。

它不是密码：源码公开，能在这台机器上运行代码的进程都可以读到它。
本工具按**单用户可信本机**设计。

## 测试

```powershell
npm test           # tablock(8) + background(27)，全部浏览器无关（mock chrome.debugger）
npm run test:ws-auth   # 浏览器侧与 node 侧的 ws-auth 互通/重放/伪造测试
```

## 相关仓库

- **synapse-skill** — agent 侧 CLI、桥注册表、路由、鉴权、doctor。
  协议契约（`ws-auth.js`，`wb-cdp-ws/2`）两侧各有一份实现，由互通测试锁住一致性。
