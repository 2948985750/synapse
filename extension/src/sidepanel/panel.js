"use strict";
// 侧面板（精简版）：选标签 / 单次 CDP。
// 砍掉了原来的：连接大脑按钮、标签列表调试输出、诊断按钮、日志区块、手动 附加/分离 按钮。
// 连接状态显示已鉴权的 WS 通道；首次使用在面板保存配对码。
// "运行"时自动 attach -> 跑 CDP -> 自动 detach（幂等，后台 lease 保证）。

const $ = (id) => document.getElementById(id);

function setState(cls, label) {
  const el = $("state");
  el.className = "state" + (cls ? " " + cls : "");
  el.textContent = label;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Only authenticated WS connections count as connected.
async function refreshStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "panel.status" });
    if (!r?.ok) throw new Error(r?.error || "状态查询失败");
    setState(r.wsConnected ? "ok" : "", r.wsConnected ? "已连接" : "等待本机工具");
  } catch (_) { setState("", "状态不可用"); }
}
refreshStatus();
const statusTimer = setInterval(refreshStatus, 3000);
window.addEventListener("unload", () => clearInterval(statusTimer));

// 标签下拉：自动拉一次，供 CDP 调用选目标 tab。
async function refreshTabs() {
  const tabs = await chrome.tabs.query({});
  const sel = $("in-tab");
  const prev = sel.value;
  sel.innerHTML = '<option value="">选择标签…</option>';
  for (const t of tabs) {
    const o = document.createElement("option");
    o.value = String(t.id);
    const title = (t.title || t.url || "").slice(0, 40);
    o.textContent = `${t.id}  ${t.active ? "·当前 " : ""}${title}`;
    sel.appendChild(o);
  }
  if (tabs.some((t) => String(t.id) === prev)) sel.value = prev;
}
refreshTabs().catch(() => setState("", "标签读取失败"));

// 单次 CDP：自动 attach -> 运行 -> detach。
$("btn-cdp").addEventListener("click", async () => {
  const tabId = Number($("in-tab").value);
  const method = $("in-method").value.trim();
  const out = $("cdp-result");
  out.className = "list";
  if (Number.isNaN(tabId) || tabId === 0) { out.textContent = "请先选择一个标签"; out.className = "list err"; return; }
  if (!method) { out.textContent = "请填写 CDP 方法（如 Runtime.evaluate）"; out.className = "list err"; return; }

  let params;
  const p = $("in-params").value.trim();
  if (p) {
    try { params = JSON.parse(p); } catch { out.textContent = "参数不是合法 JSON"; out.className = "list err"; return; }
  }

  out.textContent = "运行中…";
  const button = $("btn-cdp");
  button.disabled = true;
  let attached = false;
  try {
    const att = await chrome.runtime.sendMessage({ type: "panel.attach", tabId });
    if (!att?.ok) throw new Error("附加失败: " + (att?.error || "未知"));
    attached = true;
    const r = await chrome.runtime.sendMessage({ type: "panel.cdp", tabId, method, params });
    if (!r?.ok) throw new Error(r?.error || "CDP 调用失败");
    out.className = "list";
    out.textContent = JSON.stringify(r.result, null, 2);
  } catch (e) {
    out.textContent = "错误: " + e.message;
    out.className = "list err";
  } finally {
    if (attached) await chrome.runtime.sendMessage({ type: "panel.detach", tabId }).catch(() => {});
    button.disabled = false;
  }
});
