"use strict";
// 页内动作空间：snapshot 枚举 + click/type 的注入源码。
//
// 这里只有"字符串生成器"，不碰 chrome.* / CDP，所以任何 CDP 客户端都能复用：
// 把 snapshotExpr()/actExpr() 的返回值丢进 Runtime.evaluate 即可。
// snapshot 与 act 共用同一份 EL_COLLECTOR_SRC —— 索引必须来自同一套枚举规则，
// 否则快照索引和点击目标会错位。
//
// 交付形态：MV3 service worker 是经典脚本，用 importScripts 加载本文件；
// 因此把导出同时挂到 globalThis（浏览器）和 module.exports（node 测试）。

const EL_CANDIDATE_SEL =
  'input,button,select,textarea,a,[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[data-testid]';

// 收集器（snapshot 与 act 同源注入同一份源码）：document 级枚举 + open
// shadowRoot 递归。T-30 实证不递归时 shreddit 类 shadow 站整体不可见。
const EL_COLLECTOR_SRC =
  "function labelOf(e){return (e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('name')) || String((e.innerText||e.textContent||'').trim()).slice(0,24);}" +
  "function __elNodes(){" +
  "var SEL=" +
  JSON.stringify(EL_CANDIDATE_SEL) +
  ";" +
  "var out=[];" +
  "function collect(root){var els=root.querySelectorAll(SEL);for(var k=0;k<els.length;k++)out.push(els[k]);" +
  "var hosts=root.querySelectorAll('*');for(var h=0;h<hosts.length;h++){var sr=null;try{sr=hosts[h].shadowRoot;}catch(_){}" +
  "if(sr)collect(sr);}}" +
  "collect(document);" +
  "return [].filter.call(out,function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled;});" +
  "}";

function snapshotExpr(max) {
  const m = Number(max) > 0 ? Number(max) : 50;
  return (
    "(function(){" +
    EL_COLLECTOR_SRC +
    "var nodes=__elNodes();" +
    "var items=nodes.slice(0," +
    m +
    ").map(function(e,i){return {i:i,tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',label:labelOf(e)};});" +
    "return JSON.stringify({url:location.href,ts:Date.now(),total:nodes.length,count:items.length,items:items});})()"
  );
}

// act: "click" | "type"；typeText 以 "__CLEAR__" 前缀表示先清空；
// el = 快照条目 {i,tag,role,label}。解析校验：索引在界内 + label 未漂移。
// 动作执行期间临时接管 alert/confirm/prompt（T-30：Edge 的 chrome.debugger
// 不派发 javascriptDialogOpening，弹窗会把 evaluate 卡到超时且
// handleJavaScriptDialog 报 "No dialog is showing" 解不掉）。同步包裹、
// finally 恢复原生函数，页面事后观察不到覆写。
const ACT_QUIET_DIALOGS_SRC =
  "function withQuietDialogs(fn){var w=typeof window==='undefined'?null:window;if(!w||!w.alert)return fn();" +
  "var oa=w.alert,oc=w.confirm,op=w.prompt;" +
  "try{w.alert=function(){};w.confirm=function(){return true;};w.prompt=function(d){return d==null?'':d;};}catch(_){}" +
  "try{return fn();}finally{try{w.alert=oa;w.confirm=oc;w.prompt=op;}catch(_){}}}";

function actExpr(el, act, typeText) {
  return (
    "(function(el,act,txt){" +
    EL_COLLECTOR_SRC +
    ACT_QUIET_DIALOGS_SRC +
    "var nodes=__elNodes();" +
    "if(!(el.i>=0&&el.i<nodes.length)) return JSON.stringify({found:false,reason:'索引越界：页面已变化，请重新 snapshot'});" +
    "var target=nodes[el.i],label=labelOf(target);" +
    "if(el.label&&String(el.label).length&&label!==String(el.label))" +
    " return JSON.stringify({found:false,reason:'label 漂移：期望 '+JSON.stringify(el.label)+' 实际 '+JSON.stringify(label)+'，请重新 snapshot'});" +
    "if(act==='click'){withQuietDialogs(function(){target.click();});return JSON.stringify({found:true,clicked:label,rect:[Math.round(target.getBoundingClientRect().x),Math.round(target.getBoundingClientRect().y)]});}" +
    "if(act==='type'){var clear=typeof txt==='string'&&txt.indexOf('__CLEAR__')===0;if(clear){txt=String(txt).slice(9);try{target.value='';}catch(_){}}var proto=target.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set){d.set.call(target,txt);}else{target.value=txt;}withQuietDialogs(function(){target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));});return JSON.stringify({found:true,typed:target.value});}" +
    "return JSON.stringify({found:false,reason:'未知动作 '+JSON.stringify(act)});})" +
    "(" +
    JSON.stringify(el) +
    "," +
    JSON.stringify(act) +
    "," +
    JSON.stringify(typeText == null ? "" : typeText) +
    ")"
  );
}

const PageActions = {
  EL_CANDIDATE_SEL,
  EL_COLLECTOR_SRC,
  ACT_QUIET_DIALOGS_SRC,
  snapshotExpr,
  actExpr,
};
if (typeof globalThis !== "undefined") Object.assign(globalThis, PageActions);
if (typeof module !== "undefined" && module.exports) module.exports = PageActions;
