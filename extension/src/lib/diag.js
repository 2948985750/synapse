"use strict";
// Diagnostics: the in-memory log ring, the last native-dialog snapshots, and the
// auto-accept reaction to Page.javascriptDialogOpening.
//
// Why this is a module: it is the only stateful behaviour left in the background
// entry point, it is consumed by the `diag` command, and the dialog auto-accept
// path (T-30) had no test at all.
//
// Semantics kept from the original implementation:
//   - the ring keeps the newest N entries (default 200) and drops the oldest;
//   - a dialog snapshot keeps the newest N tabs (default 50);
//   - a page dialog blocks evaluate until timeout, so it is accepted immediately
//     (alert/confirm/prompt -> accept, beforeunload -> leave) and recorded for
//     `diag`.
//
// Dependencies are injected (the CDP send function) so it is testable in node.

function createDiag(deps = {}) {
  const sendCommand = deps.sendCommand;
  const logLimit = deps.logLimit || 200;
  const dialogLimit = deps.dialogLimit || 50;
  const now = deps.now || (() => Date.now());
  const DIALOG_TIMEOUT_MS = deps.dialogTimeoutMs || 5000;

  const entries = [];
  /** tabId -> last native dialog snapshot (Page.javascriptDialogOpening) */
  const dialogs = new Map();

  function log(level, msg, extra) {
    entries.push({ t: now(), level, msg, extra });
    if (entries.length > logLimit) entries.shift();
  }

  function noteDialog(tabId, params) {
    dialogs.set(tabId, {
      type: params?.type || "",
      message: String(params?.message || "").slice(0, 200),
      ts: now(),
    });
    if (dialogs.size > dialogLimit) {
      dialogs.delete(dialogs.keys().next().value);
    }
  }

  // React to a CDP event. Only dialog events do work here; everything else is
  // left to the capture router.
  function onCdpEvent({ source, tabId, method, params }) {
    if (method !== "Page.javascriptDialogOpening" || tabId == null)
      return false;
    noteDialog(tabId, params);
    log("warn", "page dialog opening — auto-accept", {
      tabId,
      type: params?.type,
      message: params?.message,
    });
    const target =
      source?.tabId != null
        ? { tabId: source.tabId }
        : source?.targetId
          ? { targetId: source.targetId }
          : null;
    if (target && sendCommand) {
      sendCommand(
        target,
        "Page.handleJavaScriptDialog",
        { accept: true, promptText: String(params?.defaultPrompt || "") },
        DIALOG_TIMEOUT_MS,
      ).catch((e) =>
        log("warn", "auto-accept dialog failed", { error: String(e) }),
      );
    }
    return true;
  }

  function snapshot() {
    return {
      log: entries.slice(),
      dialogs: [...dialogs.entries()].map(([tabId, d]) => ({ tabId, ...d })),
    };
  }

  return { log, entries, dialogs, noteDialog, onCdpEvent, snapshot };
}

const Diag = { createDiag };
if (typeof globalThis !== "undefined") Object.assign(globalThis, Diag);
if (typeof module !== "undefined" && module.exports) module.exports = Diag;
