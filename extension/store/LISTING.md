# Synapse → Edge 插件市场提交记录

> 生成日期：2026-10-19（2026-10-27 提交）｜包：`extension/store/synapse-0.15.1.zip`（19 条目，manifest 在根）
> 重打包流程：`node gen-icons.js`（如需换图标）→ `node build-store.js` → PowerShell `Compress-Archive`
> 图标：`icons/icon512.png` 用于商店页展示（不入 zip）。

## 0. 提交前必读（本工具的特殊性）

- 扩展本体**不采集、不上传任何用户数据**：它只在用户**本机回环**（127.0.0.1:9521-9540）
  等一个由用户自己启动的 agent 桥（`agent-collect.js`）拨入；没有任何外部端点、无遥测。
- 没有装 agent 桥的用户装了这个扩展 = 一个安静的空壳（侧面板显示未连接），无副作用。
- 商店版本与本地 unpacked 开发版**不能混跑**（两个不同 ID 会争抢同一个回环桥）：
  商店版装好后，`edge://extensions` 里停用/删除 unpacked 的 Synapse，否则双 SW 互拨。

## 1. 开发者账号与上传（你来做）

1. 打开 <https://aka.ms/edgedevcenter>，用 Microsoft 账号登录 → 免费注册
   Edge 开发者（个人，免费）。
2. 同意开发者协议 → **Create extension**。
3. 上传 `synapse-store.zip`（Edge Add-ons 收 zip，manifest.json 必须在 zip 根）。
4. 填列表字段（见 §2）→ 指定 **隐私政策 URL**（见 §3，必填）→ 提交审核。
5. 审核通常 1-3 个工作日；被问就按 §4 的预写答案回。

## 2. 列表字段（可直接粘贴）

- **显示名称**：Synapse
- **分类**：Developer tools（开发工具）；渠道：Production；操作系统：Windows
- **短描述**（≤32 字符，按需选语言）：
  - 英文：`AI-agent bridge for your browser`（32）
  - 中文：`让 AI 助手驱动你已登录的浏览器`（14）
- **长描述**（英文，商店页正文）：
  > Synapse lets an AI coding agent on your machine drive the browser you are
  > already logged into: open tabs, read the rendered DOM, click and type,
  > and capture the page's own network responses — all over a secure
  > loopback WebSocket bridge you start locally. No --remote-debugging-port,
  > no cloud, no telemetry: the extension only ever talks to 127.0.0.1 on
  > your own machine. Without the local bridge running it stays quietly
  > inactive.
- **长描述**（中文）：
  > Synapse 让本机的 AI 编程助手驱动你已登录的浏览器：开标签、读渲染后的 DOM、
  > 点击与输入、捕获页面自身发出的网络响应——全部经由你在本机启动的回环
  > WebSocket 桥完成。无需 --remote-debugging-port，无云端、无遥测：扩展只与
  > 127.0.0.1 通信。未启动本地桥时扩展保持静默无动作。

## 3. 隐私政策（商店必填，需一个公开可访问的 HTTPS URL）

**已部署上线** ✅ —— 隐私政策 URL：

```
https://2948985750.github.io/synapse/
```

- 公开仓库：https://github.com/2948985750/synapse（文件 `docs/index.html`，Pages 源 main /docs）。
- 页面是零依赖单页（英文正文 + 中文摘要），源文件在
  `extension/store/privacy-policy.html`。

政策核心（页面已含全文）：本扩展**不收集/不传输/不存储任何数据**、无服务端、
无遥测；仅与用户自己在本机启动的 agent 桥通过 127.0.0.1 回环通信。

> ⚠️ 本机网络备注：这台机器的命令行 `git`（经 `127.0.0.1:7897` 代理或直连）
> 到不了 GitHub（被中间盒截断/重置），**只有 Edge 浏览器会话能访问 GitHub**。
> 日后更新政策页请用浏览器驱动（`agent-collect.js` 的 Web UI 逐文件提交），
> 不要指望本机 `git push`；GitHub Pages 的审核方（Microsoft 侧）可正常访问。

## 4. 审核问答（预写答案，审核员问起直接回）

- **Q: 为什么需要 `debugger` 权限？**
  本扩展的定位是"让本机 AI 代理以 CDP 全量透传操作用户自己的浏览器标签"
  （读取渲染 DOM、驱动输入、捕获页面自身 API 响应），`chrome.debugger` 是实现
  这一点的唯一浏览器 API；权限使用范围与 `tabGroups`/`tabs` 一并服务于
  用户显式发起的本地自动化任务。
- **Q: 为什么需要 `<all_urls>` host 权限？**
  工具需要能驱动用户**任意已登录站点**的标签（读 DOM/网络/执行页内 JS），
  站点集合由用户自己的 agent 任务决定，无法在 manifest 里预先枚举。
- **Q: 收集什么数据？** 无。没有任何网络端点，只有 127.0.0.1 回环桥
  （由用户本地启动），认证密钥仅用于回环握手，无遥测、无统计。
- **Q: 这个扩展对普通用户有什么用 / 谁会装它？**
  跑"AI 编程代理 + 浏览器自动化"工作流的用户：让 agent 复用浏览器里的
  登录态做受控自动化（采集、填表、测试）。不启动本地 agent 时扩展零行为。
- **Q: native messaging？** 无原生 host、不打包任何本地程序；权限已从
  manifest 移除（v0.15.1）。

## 5. 提交记录（2026-10-27）

- 账号：个人主体 psn_b2unrtbb，发布者 **Synapse Labs**（Individual）
- 包：`extension/store/synapse-0.15.1.zip`（19 条目，manifest description 已压到 132 字符内）
- Store ID：`0RDCK9Q0ZRPT`；CRX ID：`eiidjpnhaaiejgagkdanikjhbknmlplm`
- 状态：**In review**（2026-10-27 提交，官方提示 7 个工作日内）
- 列表：英文（美国），分类 Developer Tools，Public，全部 241 市场
- 隐私表单：单用途 + 5 个权限理由 + 不收集数据 + 3 项认证；测试无需凭据

## 6. 版本与维护约定

- 商店版本号必须单调递增（`manifest.json` 0.15.1 → 下次 0.15.2+），
  **本地 unpacked 版与商店版共用同一份源码**：发布前先 bump 版本再打包。
- 商店版走浏览器自动更新；本地 doctor/T-17 的"清 SW 缓存 + --load-extension
  强刷"剧本**只适用于 unpacked 版**。商店版掉线恢复 = 重启 Edge 即可。
- 商店里装好后：unpacked 版停用，agent 侧 `serve/doctor/status` 全不变
  （SW 照旧拨入回环桥）。
