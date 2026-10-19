# Synapse — CDP Browser Bridge

让**本机的 AI 编程代理**驱动你**已登录**的 Chrome/Edge：读渲染 DOM、
驱动输入、捕获页面自身 API 响应、跑任意页内 JS。核心是一个 MV3 扩展
（`chrome.debugger` 全量 CDP 透传）+ 一个 agent 侧 WebSocket 桥。
无 `--remote-debugging-port`、无 native-messaging。

## 工作原理

```
你的程序 / agent（native-host/agent-collect.js）
      │  本机回环起 WS server（127.0.0.1:9521-9540）
      ▼  ◄── 扩展 service worker 主动拨入（保持 SW 存活）
扩展（extension/src/background.js，chrome.debugger.attach → CDP 全透传）
      ▼
你活着的浏览器（登录态在里面）
```

- 多会话并发：每会话一个桥（`data/bridges/<session>.json` 注册表），
  one-shot 按 会话桥→其它活桥→直连 级联故障转移。
- 链路恢复：`agent-collect.js doctor`（礼貌等待 → 锁协调硬刷）。

## 目录

| 路径 | 内容 |
|---|---|
| `extension/` | MV3 扩展本体（manifest + src + icons） |
| `extension/store/` | 商店发布工具（`gen-icons.js`、`build-store.js`、`LISTING.md`） |
| `native-host/` | agent 侧 CLI/桥（`agent-collect.js` + 路由 + vendored ws） |
| `package.json` | `npm test`（tablock / background / bridge 测试，浏览器无关） |

## 快速开始（本地 unpacked）

1. 浏览器 `edge://extensions` 开发者模式 → 加载已解压 → 选 `extension/`。
2. `node native-host/agent-collect.js serve mysession`
3. 设置环境变量 `WB_SESSION=mysession` 后运行
   `node native-host/agent-collect.js list`（后续命令都带这个环境变量走自己的桥）
   - Windows: `set WB_SESSION=mysession`（cmd）或 `$env:WB_SESSION="mysession"`（PowerShell）
4. 链路异常：`node native-host/agent-collect.js doctor`

命令面：`list / open / navigate / run / cdp / capture / snapshot / click-el /
type-el / status / serve / doctor / --keep …`（详见
`native-host/agent-collect.js` 的 `usage()`）。

## 测试

```bash
npm test   # 全部浏览器无关（mock chrome.debugger / 真实 WS fixture）
```

## 发布到 Edge 商店

`node extension/store/build-store.js` 生成干净 dist（manifest 在根，无测试件/
桥代码）→ 打 zip 上传 aka.ms/edgedevcenter；列表文案与审核问答在
`extension/store/LISTING.md`。

## 隐私

无任何服务端/遥测；扩展只与用户本机启动的桥经 127.0.0.1 通信。
（隐私政策页见仓库外 `synapse-privacy` Pages 站点。）
