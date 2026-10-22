# Synapse

让**本机的 AI 编程代理**驱动你**已登录**的 Chrome/Edge：读渲染 DOM、驱动输入、
捕获页面自身 API 响应、跑任意页内 JS。

核心是一个 MV3 扩展（`chrome.debugger` 全量 CDP 透传）+ 一个 agent 侧回环 WebSocket 桥。
无 `--remote-debugging-port`、无 native messaging、无服务端、无遥测。

```
你的程序 / agent（agent/agent-collect.js）
      │  本机回环起 WS server（127.0.0.1:9521-9540）
      ▼  ◄── 扩展 service worker 主动拨入（保持 SW 存活）
扩展（extension/src/background.js，chrome.debugger.attach → CDP 全透传）
      ▼
你活着的浏览器（登录态在里面）
```

- 多会话并发：每会话一个桥（`data/bridges/<session>.json` 注册表），
  one-shot 按 会话桥 → 其它活桥 → 直连 级联故障转移。
- 链路恢复：`agent-collect.js doctor`（礼貌等待 → 维护锁协调硬刷）。

## 分层：哪些归扩展，哪些归 agent

判定标准只有一条：**浏览器要加载的 → 扩展层；`require` 进来的 → agent 层。**

| 层 | 跑在哪 | 内容 | 目录 |
|---|---|---|---|
| **扩展层** | 浏览器 MV3 service worker | `manifest.json`、service worker、`chrome.debugger` attach 与透传、页内 JS 注入、`Input.dispatch*` 物理输入、**浏览器侧** `ws-auth.js` | `extension/src/` |
| **Agent 层** | node 进程 | CLI 解析、桥发现/注册表/故障转移、`bridge-router`（tab FIFO + clientId 租约）、`bridge-auth`（node 侧）、`paths`、`doctor`、测试 | `agent/` |

两侧各有一份 `ws-auth.js`（HMAC 挑战/证明），这是**唯一合理的重复**：浏览器不能
`require` node 模块，两边用同一套协议做对等鉴权，由 `extension/src/test-ws-auth.js`
的互通测试锁住一致性。

> 目录名不使用 `native-host`：那是 [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
> 通道的名字，本项目**没有**用它（早年的宿主实现已废弃）。桥走的是 127.0.0.1 WebSocket，
> 所以 node 侧叫 `agent/`。

## 目录

| 路径 | 内容 |
|---|---|
| `extension/` | MV3 扩展本体（`manifest.json` + `src/` + `icons/`） |
| `extension/store/` | 商店发布工具（`gen-icons.js`、`build-store.js`、`LISTING.md`） |
| `agent/` | agent 侧 CLI/桥（`agent-collect.js` + 路由 + 鉴权 + vendored ws） |
| `agent/paths.js` | 路径集中解析（`WB_*` 环境变量），同一份文件在 cdp 里也能用 |
| `scripts/sync-cdp-vendor.js` | 把 `agent/` 同步到 cdp skill 的 vendored 位置（带 `--check`） |
| `package.json` | `npm test` / `npm run verify` |

## 快速开始（本地 unpacked）

1. 浏览器 `edge://extensions`（或 `chrome://extensions`）→ 开发者模式 →
   加载已解压 → 选 `extension/`。
2. 起一个常驻桥，并记住会话名：

   ```powershell
   node agent/agent-collect.js serve mysession
   ```

3. 之后每条命令都带 `--session mysession`，毫秒级走自己的桥：

   ```powershell
   node agent/agent-collect.js status --session mysession
   node agent/agent-collect.js list   --session mysession
   node agent/agent-collect.js open "https://example.com" --session mysession
   ```

   > `--session <sid>` 与环境变量 `WB_SESSION` 等价。**Windows 下用 `--session`**，
   > `WB_SESSION=x node ...` 是 POSIX 前置写法，PowerShell 不认（要用
   > `$env:WB_SESSION="mysession";` 单独一行）。

4. 链路异常：`node agent/agent-collect.js doctor`。

命令面：`list / open / navigate / close / run / cdp / capture / capture-many /
snapshot / click-el / type-el / attach / detach / diag / status / serve / pair /
doctor`（`--keep / --wait / --force / --dry / --nowait / --sync / --all` 等选项见
`node agent/agent-collect.js` 的 `usage()`）。

## 路径配置

路径不硬编码，全部由 `agent/paths.js` 解析（向上找含 `SKILL.md` / 仓库根的目录）：

| 变量 | 缺省 | 用途 |
|---|---|---|
| `WB_DATA_DIR` | `data/` | 数据根（注册表 / 遗留单文件 / 维护日志） |
| `WB_BRIDGE_DIR` | `<data>/bridges` | 多会话桥注册表目录 |
| `WB_BRIDGE_FILE` | `<data>/bridge.json` | 遗留单文件桥记录 |
| `WB_CDP_EXT_DIR` | 候选推导 → 报错 | `doctor` 硬刷时的 `--load-extension` 根（须含 `manifest.json`） |
| `WB_EDGE_EXE` | 自动查找 `msedge.exe` | Edge 可执行文件 |
| `WB_AGENT_WS_START` / `WB_AGENT_WS_END` | `9521` / `9540` | 端口段（须与扩展一致） |

`data/` 是运行时工作区，不进版本控制（见 `.gitignore`），首次运行自动创建。

## 测试

```powershell
npm test              # tablock(8) + background(27) + agent bridge(28)，全部浏览器无关
npm run test:ws-auth  # 浏览器侧与 node 侧 ws-auth 的互通/重放/伪造测试
npm run verify        # syntax + npm test + cdp vendored 副本漂移检测
```

## 与 cdp skill 的关系

cdp skill（`~/.../cdp`）里有一份 `agent/` 的**逐字节副本**，位于
`cdp/extension/native-host/`——那是历史存放位置，为了不牵动 cdp 里 ~30 处
`agent-collect.js` 引用而保留。副本由本仓库生成，不要手改：

```powershell
npm run sync-cdp     # 写入 cdp
npm run check-drift  # 校验（漂移则退出码 1）
```

`agent/paths.js` 靠"向上找 skill 根"适配两种布局，因此同一份文件在
`<repo>/agent/` 与 `<cdp>/extension/native-host/` 下解析出的 `DATA_ROOT`
分别指向各自的 `data/`，扩展根都指向 `cdp/extension`，无需任何条件分支。

## 发布到 Edge 商店

`node extension/store/build-store.js` 生成干净 dist（manifest 在包根，无测试件、
无 agent 侧代码）→ 打 zip 上传 [aka.ms/edgedevcenter](https://aka.ms/edgedevcenter)；
列表文案与审核问答在 `extension/store/LISTING.md`。

## 隐私

无任何服务端 / 遥测；扩展只与用户本机启动的桥经 `127.0.0.1` 通信。
（隐私政策页见仓库外的 `synapse-privacy` Pages 站点。）
