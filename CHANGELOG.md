# 变更记录

本文件记录**修复过的问题**与结构性变更，重点写「为什么改成这样」。
agent 侧（CLI / 桥 / 路由 / 鉴权）在独立仓库 [synapse-skill](https://github.com/2948985750/synapse-skill)。

---

### BUG-2 侧边栏仍保留配对 UI（与"去掉鉴权 UI"的决定不符）

- **现象**：侧边栏顶部仍有「浏览器与本机工具配对」区块（64 位配对码输入 + 保存配对按钮），
  提示文案还指向已删除的 `extension/native-host/agent-collect.js`。
- **修法**：整块移除（标题/说明/输入框/按钮/结果行），面板只剩状态与 CDP 调用；
  `panel.js` 删除 `btn-pair` 监听与 `needsPairing` 分支。
- **注意**：浏览器里当前加载的若是旧的 `cdp/extension`，需重新加载扩展才会生效。

---

### 变更：鉴权标识改为内置常量，移除配对 UI 与 storage 令牌

- `ws-auth.js` 的 `DEFAULT_TOKEN` 换成一枚项目专用的固定标识（与 agent 仓库同值）。
- `loadBridgeToken()` 直接返回该常量，不再读 `chrome.storage`；
  删除 `applyBridgeToken` / `replaceBridgeToken` / `panel.setToken` / storage 监听。
- `panel.status` 不再返回 `needsPairing`。

---

### 工程：版本单一来源校验 + 发布前检查

- 新增 `scripts/verify-version.js`：`extension/manifest.json` 与 `package.json` 的版本必须一致，
  不一致直接 exit 1。已接进 `npm test`（每次测试都会校验）。
- 新增 `npm run release:check`：版本校验 + `build:store` 一条命令跑完。
- 负向验证：把 package.json 改成 9.9.9 → 脚本报「版本不一致」并以 exit 1 退出。
- 打首个基线 tag `v0.15.1`（此前仓库没有任何 tag）。

---

## 2026-10-23 — 配对令牌持久化

### BUG-1 扩展忽略已保存的配对令牌（与 node 侧配对闭环配套）

- **现象**：侧边栏「保存配对」后，扩展只在当次 service worker 生命周期内用这个令牌；
  SW 一挂起重启就回到内置默认密钥，而对端（node）此时可能已经在用随机令牌 → 连接失败。
- **根因**：`loadBridgeToken()` 无条件返回 `WSAuth.DEFAULT_TOKEN`，从不读 `chrome.storage.local`。
- **修法**：优先读 `wbBridgeToken`，无效/缺失才回落默认；`storage.local.get` 不可用时也有兜底。
- **测试**：`test-background` 里两条用例改为断言「storage 有令牌就必须用它」。
- **配套**：node 侧 `readToken()` 同步改为读 `data/bridge-auth.json`（见 synapse-skill 的 CHANGELOG）。

---

## 2026-10-22

### 仓库拆分

- **变更**：本仓库只保留浏览器扩展（`extension/`）与商店发布工具；agent 侧整体移到 `synapse-skill`。
- **原因**：node 代码原来塞在 `extension/native-host/` 下，看起来像扩展的一部分，实际
  `extension/store/build-store.js` 一直把它排除在商店包外。两套东西放一棵树里，导致
  「扩展要发布」和「桥要迭代」互相干扰。
- **兼容**：扩展与 agent 之间只有 WS 协议（`wb-cdp-ws/2`，端口 9521-9540），拆开不影响运行。
- 提交 `77fcc23`

### 修复：`package.json` 名称与测试路径错误

- **现象**：`npm test` 直接失败。
- **根因**：拆分前的 `package.json` 还叫 `cdp-browser`，测试脚本指向
  `extension/native-host/test-bridge.js` —— 该路径在重构后已不存在。
- **修法**：改名 `synapse`，测试只跑扩展（`test-tablock` + `test-background`），
  另加 `test:ws-auth` 与 `build:store`。

### 修复：侧边栏配对提示指向了不存在的路径

- **现象**：用户照侧边栏提示敲命令会报「找不到文件」。
- **根因**：文案写着 `node extension/native-host/agent-collect.js pair`，拆分后该目录已移除。
- **修法**：改为指向 `synapse-skill` 仓库的 `agent/agent-collect.js`。
- 提交 `77fcc23`

### 文档

- README 重写为扩展视角：目录说明、权限与隐私表（每个权限为什么需要）、商店构建步骤、
  与 agent 仓库的关系。
- 提交 `77fcc23`

---

## 拆分前的相关修复（历史，提交仍在）

- `e02d00d`：修掉远端遗留硬伤 —— `package.json` 还叫 `cdp-browser`；`native-host/` 更名为
  `agent/`（原名字指已废弃的 native messaging 通道，而 README 自己写着「无 native-messaging」）。
- `a4e5c2f`：agent 侧的 4 个缺陷（清理超时、`lateStarts` 上限、`crypto` 未引入、
  `--filter` 错误码），详见 synapse-skill 的 CHANGELOG。
- `525d778`：agent 侧单文件 1677 行拆成 9 个模块 + 原子写 + 命令表。

---

## 已知待办

- **商店 zip 落后于源码**：`extension/src/sidepanel/index.html` 在 `77fcc23` 改过，
  发布前需重跑 `npm run build:store` 并重新打包。
