"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const auth = require("../src/ws-auth.js");
const TOKEN_FILE = process.env.WB_BRIDGE_AUTH_FILE || path.join(__dirname, "..", "..", "data", "bridge-auth.json");
const PAIR_HELP = "Bridge is not paired. Run node extension/native-host/agent-collect.js pair, then enter that token in the extension settings.";
function readToken() {
  // Token 机制已退役：仅限 127.0.0.1 回环，固定使用内置默认密钥，不再读取文件/环境变量。
  return auth.DEFAULT_TOKEN;
}
function pairToken() {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (saved.protocol === auth.PROTOCOL && auth.validToken(saved.token)) return saved.token;
  } catch (_) {}
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ protocol: auth.PROTOCOL, token }) + "\n", { mode: 0o600 });
  return token;
}
function authenticateServer(socket, request, token, onAuthenticated, timeoutMs = 5000) {
  const origin = request?.headers?.origin;
  const serverNonce = auth.createNonce();
  let settled = false;
  let verifying = false;
  const timer = setTimeout(() => fail("Authentication timed out"), timeoutMs);
  const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); socket.off("close", onClose); };
  const onClose = () => { settled = true; cleanup(); };
  function fail(reason) {
    if (settled) return;
    settled = true; cleanup();
    try { socket.close(1008, reason); } catch (_) { socket.terminate(); }
  }
  async function onMessage(raw) {
    if (settled) return;
    if (verifying) { fail("Authentication must finish before commands"); return; }
    verifying = true;
    try {
      const message = JSON.parse(raw.toString());
      if (message.type !== "auth.response" || message.protocol !== auth.PROTOCOL || !["extension", "client"].includes(message.role)) throw new Error("Authentication required");
      if (origin && (message.role !== "extension" || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) throw new Error("Origin is not allowed");
      if (!await auth.verify(token, message.role, "client", serverNonce, message.nonce, message.proof)) throw new Error("Authentication failed");
      const proof = await auth.sign(token, message.role, "server", serverNonce, message.nonce);
      if (settled || socket.readyState !== 1) return;
      settled = true; cleanup();
      socket.send(JSON.stringify({ type: "auth.ok", protocol: auth.PROTOCOL, proof }));
      onAuthenticated(message.role);
    } catch (_) { fail("Authentication failed"); }
  }
  socket.on("message", onMessage);
  socket.on("close", onClose);
  socket.on("error", () => fail("Socket error"));
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { fail("Origin is not allowed"); return; }
  socket.send(JSON.stringify({ type: "auth.challenge", protocol: auth.PROTOCOL, nonce: serverNonce }));
}
function authenticateClient(socket, token, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stage = "challenge", serverNonce, clientNonce;
    let settled = false;
    const timer = setTimeout(() => fail("Bridge authentication timed out"), timeoutMs);
    function cleanup() { clearTimeout(timer); socket.off("message", onMessage); socket.off("error", onError); socket.off("close", onClose); }
    function fail(reason) { if (settled) return; settled = true; cleanup(); reject(new Error(reason)); }
    const onError = () => fail("Bridge connection failed");
    const onClose = () => fail("Bridge disconnected before authentication");
    async function onMessage(raw) {
      try {
        const message = JSON.parse(raw.toString());
        if (message.protocol !== auth.PROTOCOL) throw new Error("Unexpected bridge protocol");
        if (stage === "challenge" && message.type === "auth.challenge") {
          stage = "signing";
          serverNonce = message.nonce;
          clientNonce = auth.createNonce();
          const proof = await auth.sign(token, "client", "client", serverNonce, clientNonce);
          if (settled) return;
          stage = "confirmation";
          socket.send(JSON.stringify({ type: "auth.response", protocol: auth.PROTOCOL, role: "client", nonce: clientNonce, proof }));
        } else if (stage === "confirmation" && message.type === "auth.ok") {
          stage = "verifying";
          if (!await auth.verify(token, "client", "server", serverNonce, clientNonce, message.proof)) throw new Error("Bridge proof is invalid");
          if (settled) return;
          settled = true; cleanup(); resolve();
        } else throw new Error("Unexpected authentication message");
      } catch (error) { fail(error.message); }
    }
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}
module.exports = { readToken, pairToken, authenticateServer, authenticateClient, TOKEN_FILE };
