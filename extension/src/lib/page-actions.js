"use strict";
// In-page action space: the injected source behind snapshot and click/type.
//
// These are string builders only — no chrome.*, no CDP — so any CDP client
// can reuse them: feed the result of snapshotExpr()/actExpr() into
// Runtime.evaluate.
// snapshot and act share one EL_COLLECTOR_SRC: indexes must come from the same
// enumeration rules, otherwise snapshot indexes and click targets drift.
//
// Shipped as a classic script (importScripts in the MV3 worker), so exports
// are attached to both globalThis and module.exports.

const EL_CANDIDATE_SEL =
  'input,button,select,textarea,a,[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[data-testid]';

// Collector (injected identically for snapshot and act): document-level
// enumeration plus open shadowRoot recursion. T-30 showed that without the
// recursion, shadow-DOM sites such as shreddit are entirely invisible.
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

// act: "click" | "type"; a "__CLEAR__" prefix on typeText clears the field
// first. el is a snapshot entry {i,tag,role,label}; resolution checks both the
// index bounds and label drift.
// Native dialogs are temporarily neutralised while acting (T-30: Edge's
// chrome.debugger does not dispatch javascriptDialogOpening, so a dialog
// blocks evaluate until timeout and handleJavaScriptDialog reports "No
// dialog is showing"). The override is synchronous and restored in finally,
// so the page cannot observe it afterwards.
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
    "if(!(el.i>=0&&el.i<nodes.length)) return JSON.stringify({found:false,reason:'index out of range: page changed, re-run snapshot'});" +
    "var target=nodes[el.i],label=labelOf(target);" +
    "if(el.label&&String(el.label).length&&label!==String(el.label))" +
    " return JSON.stringify({found:false,reason:'label drift: expected '+JSON.stringify(el.label)+' actual '+JSON.stringify(label)+', re-run snapshot'});" +
    "if(act==='click'){withQuietDialogs(function(){target.click();});return JSON.stringify({found:true,clicked:label,rect:[Math.round(target.getBoundingClientRect().x),Math.round(target.getBoundingClientRect().y)]});}" +
    "if(act==='type'){var clear=typeof txt==='string'&&txt.indexOf('__CLEAR__')===0;if(clear){txt=String(txt).slice(9);try{target.value='';}catch(_){}}var proto=target.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set){d.set.call(target,txt);}else{target.value=txt;}withQuietDialogs(function(){target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));});return JSON.stringify({found:true,typed:target.value});}" +
    "return JSON.stringify({found:false,reason:'unknown action '+JSON.stringify(act)});})" +
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
if (typeof module !== "undefined" && module.exports)
  module.exports = PageActions;
