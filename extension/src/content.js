"use strict";
// Content script — localhost pages only (see manifest matches).
//
// Handoff protocol (original, our own data-attribute namespace so it never
// collides with any site's DOM): the page can mark an element with
//   data-wb-cdp-ready="true"
// to opt into agent reachability; we then publish a status attribute the
// page (or the agent driving it) can read to know the extension is alive.
//
// This is the same *idea* as the ChatGPT extension's content script
// (GET status / tab context via data attributes), re-implemented from scratch.

const ATTR = {
  optIn: "data-wb-cdp-ready",
  status: "data-wb-cdp-extension-status",
  requested: "data-wb-cdp-request-status",
};

function publish(status) {
  document.documentElement.setAttribute(ATTR.status, JSON.stringify(status));
}

function handleOptIn(el) {
  if (!el || el.nodeType !== 1) return;
  // Idempotency guard (E9): the same element can be reached twice — once as
  // its own added node, again as a descendant of an added container, or via
  // the initial scan. Ask only once; the status is re-published when the
  // background answers, so repeating the request just spams the channel.
  if (el.getAttribute(ATTR.requested) === "true") return;
  el.setAttribute(ATTR.requested, "true");
  chrome.runtime
    .sendMessage({ type: "content.status" })
    .then((res) => publish(res))
    .catch((e) => publish({ ok: false, error: String(e) }));
}

function scanOptIns(root) {
  // querySelectorAll does NOT include the root itself, so check it explicitly
  // (covers an opt-in attribute placed directly on <html>).
  if (root.nodeType === 1 && root.matches?.(`[${ATTR.optIn}]`)) handleOptIn(root);
  root.querySelectorAll?.(`[${ATTR.optIn}]`).forEach(handleOptIn);
}

// Observe the document for elements opting in.
const observer = new MutationObserver((muts) => {
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (n.nodeType === 1) scanOptIns(n);
    }
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

// Catch already-present opt-ins on load (including on the document root).
scanOptIns(document.documentElement);
