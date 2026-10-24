#!/usr/bin/env node
"use strict";
// Real-browser E2E smoke test for the Synapse extension.
//
// What it does (no dependencies, uses the installed Edge/Chrome):
//   1. launches the browser with a throwaway profile and the unpacked extension
//   2. starts an agent bridge (agent-collect.js serve) and waits for the
//      extension to dial in
//   3. drives the real stack: status -> open -> snapshot -> click -> navigate
//      -> capture -> diag -> close
//   4. tears everything down (browser tree, bridge, temp profile)
//
// Why: unit tests mock chrome.*. They cannot catch a broken importScripts list,
// a store build that forgets lib/*.js, a manifest permission that is too narrow,
// or a service worker that fails to start. This can.
//
//   node scripts/e2e-smoke.js [--keep] [--browser <path>] [--timeout <ms>]
//
// Exit code 0 = all checks passed; 1 = a check failed or the harness broke.
// A foreign browser already connected to the bridge is detected and the run is
// retried on a fresh port (the local dev machine often has its own browser open).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION = path.join(ROOT, "extension");
const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : fallback;
};
const KEEP = ARGS.includes("--keep");
const TIMEOUT_MS = Number(opt("--timeout", "150000"));
const CONNECT_WAIT_MS = Number(opt("--connect-wait", "25000"));
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  process.stdout.write("[e2e] " + msg + "\n");
}

// ---------------- dependencies ----------------
function agentPath() {
  const explicit = process.env.SYNAPSE_AGENT;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const installed = path.join(home, "skills", "synapse-skill", "agent", "agent-collect.js");
  if (fs.existsSync(installed)) return installed;
  const sibling = path.resolve(ROOT, "..", "synapse-skill", "agent", "agent-collect.js");
  if (fs.existsSync(sibling)) return sibling;
  throw new Error(
    "cannot find agent-collect.js — install the synapse-skill skill or set SYNAPSE_AGENT",
  );
}

function browserPath() {
  const explicit = opt("--browser", process.env.SYNAPSE_BROWSER);
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error("browser not found: " + explicit);
    return explicit;
  }
  const candidates =
    process.platform === "win32"
      ? [
          path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  const hit = candidates.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error("no Edge/Chrome found; pass --browser <path>");
  return hit;
}

// ---------------- browser lifecycle ----------------
function launchBrowser(exe, profileDir) {
  const args = [
    "--user-data-dir=" + profileDir,
    "--disable-extensions-except=" + EXTENSION,
    "--load-extension=" + EXTENSION,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=-32000,-32000",
    "--window-size=1024,768",
    "about:blank",
  ];
  log("launching " + path.basename(exe));
  const child = spawn(exe, args, { stdio: "ignore", windowsHide: false });
  child.on("error", (e) => log("browser spawn error: " + e.message));
  return child;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (_) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (_) {}
    }
  }
}

// ---------------- bridge lifecycle ----------------
function startBridge(agent, session) {
  const child = spawn(process.execPath, [agent, "serve", session], {
    cwd: path.dirname(agent),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("error", () => {});
  return { child, output: () => out };
}

// `status` is a CLI-only command (registry probe), not part of the WS protocol,
// so poll it through the CLI and only then open an API channel.
function readStatus(agent, session) {
  const r = spawnSync(process.execPath, [agent, "status", "--session", session], {
    cwd: path.dirname(agent),
    encoding: "utf8",
    timeout: 15000,
  });
  const line = String(r.stdout || "").split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

async function waitForExtension(agent, session, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const status = readStatus(agent, session);
    last = status;
    if (status && status.ok && status.extension && (status.extension.wsAgents || []).length) {
      return status;
    }
    await sleep(1000);
  }
  throw new Error(
    "extension did not attach within " + timeoutMs + "ms (last status: " + JSON.stringify(last) + ")",
  );
}

async function connectAgent(session, agent, timeoutMs) {
  const status = await waitForExtension(agent, session, timeoutMs);
  const { connect } = require(path.join(path.dirname(agent), "api.js"));
  const browser = await connect({ session });
  return { browser, status };
}
// ---------------- assertions ----------------
let passed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    log("  ok   " + name + (detail ? "  (" + detail + ")" : ""));
  } else {
    throw new Error("check failed: " + name + (detail ? " — " + detail : ""));
  }
}

async function drive(browser, status) {
  check("status ok", !!status.ok, "fastPath=" + status.fastPath);
  check("extension attached", (status.extension.wsAgents || []).length > 0, JSON.stringify(status.extension.wsAgents));

  const tabs0 = await browser.tabs();
  check("fresh profile has only blank tabs", tabs0.every((t) => /^(about:blank|edge:\/\/newtab|chrome:\/\/newtab)/.test(String(t.url))), "tabs=" + tabs0.length);

  const t0 = Date.now();
  const opened = await browser.open("https://example.com", { waitMs: 8000 });
  check("open loaded", opened.loaded === true, (Date.now() - t0) + "ms, tab=" + opened.tabId);
  const tab = opened.tabId;

  const snap = await browser.snapshot(tab, { max: 10 });
  const items = (snap && snap.items) || [];
  check("snapshot returns controls", items.length > 0, "count=" + items.length);
  const target = items.find((x) => /learn more/i.test(x.label || "")) || items[0];

  const clicked = await browser.click(tab, target.i, { label: target.label });
  check("click-el resolves the snapshot entry", clicked && clicked.found === true, JSON.stringify(clicked));

  let href = "";
  for (let i = 0; i < 10; i++) {
    const r = await browser.run(tab, "location.href");
    href = String(r && r.result ? r.result.value : "");
    if (/iana\.org/.test(href)) break;
    await sleep(500);
  }
  check("navigation after click", /iana\.org/.test(href), href);

  await browser.call("navigate", { tabId: tab, url: "https://example.com" });
  await sleep(1500);
  const cap = await browser.call("capture", { tabId: tab, action: "reload", durationMs: 4500, bodyMaxKb: 256 });
  check("capture session started and routed events", !!cap && (cap.totalRequestsSeen || 0) > 0, "seen=" + (cap && cap.totalRequestsSeen));

  const diag = await browser.call("diag", {});
  check("diag responds", !!diag, "keys=" + Object.keys(diag || {}).join(","));

  const closed = await browser.closeTab(tab);
  check("close tab", closed && closed.closed === true, JSON.stringify(closed));
}

// ---------------- main ----------------
(async () => {
  const started = Date.now();
  const agent = agentPath();
  const exe = browserPath();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-"));
  let browserChild = null;
  let bridge = null;
  let browser = null;
  let status = null;
  let lastSession = null;

  const cleanup = async () => {
    try {
      if (browser) await browser.close();
    } catch (_) {}
    if (bridge && bridge.child && !bridge.child.killed) killTree(bridge.child.pid);
    killTree(browserChild && browserChild.pid);
    if (KEEP) {
      log("keeping profile for debugging: " + profileDir);
    } else {
      await sleep(500);
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch (_) {}
    }
  };

  try {
    log("extension: " + EXTENSION);
    log("agent    : " + agent);
    log("browser  : " + exe);

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !browser; attempt++) {
      const session = "e2e-" + attempt;
      lastSession = session;
      // Start the bridge first: the throwaway worker dials as soon as it boots,
      // while an already-running browser only picks the port up on its next 5s
      // scan. Launching the browser per attempt also keeps its dial fresh.
      bridge = startBridge(agent, session);
      await sleep(300);
      if (browserChild) {
        killTree(browserChild.pid);
        await sleep(800);
      }
      browserChild = launchBrowser(exe, profileDir);
      try {
        const connected = await connectAgent(session, agent, CONNECT_WAIT_MS);
        const tabs = await connected.browser.tabs();
        const foreign = tabs.some((t) => !/^(about:blank|edge:\/\/newtab|chrome:\/\/newtab)/.test(String(t.url)));
        if (foreign) {
          // Another browser on this machine won the port; retry on a fresh one.
          log("attempt " + attempt + ": another browser owns this bridge, retrying");
          await connected.browser.close();
          killTree(bridge.child.pid);
          bridge = null;
          continue;
        }
        browser = connected.browser;
        status = connected.status;
        log("bridge session " + session + " (attempt " + attempt + ")");
      } catch (e) {
        lastError = e;
        log("attempt " + attempt + " failed: " + e.message);
        if (bridge) killTree(bridge.child.pid);
        bridge = null;
      }
    }
    if (!browser) throw lastError || new Error("could not get an isolated bridge");

    await drive(browser, status);
    log("PASS (" + passed + " checks, " + ((Date.now() - started) / 1000).toFixed(1) + "s)");
    await cleanup();
    process.exit(0);
  } catch (e) {
    log("FAIL: " + (e && e.message ? e.message : e));
    try {
      if (bridge) {
        const dump = lastSession ? readStatus(agent, lastSession) : null;
        if (dump) log("status dump: " + JSON.stringify(dump).slice(0, 400));
      }
    } catch (_) {}
    await cleanup();
    process.exit(1);
  }
})();
