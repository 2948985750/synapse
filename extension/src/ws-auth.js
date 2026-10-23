"use strict";
// Shared by the MV3 worker and Node. Challenge proofs never transmit the key.
(function (root, factory) {
  const cryptoApi = root.crypto || (typeof require === "function" ? require("crypto").webcrypto : null);
  const api = factory(cryptoApi);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WSAuth = api;
})(globalThis, function (cryptoApi) {
  const PROTOCOL = "wb-cdp-ws/2";
  // 未配对时的默认回环密钥：双方都缺省即退化为旧版"无 token"行为（仍仅限 127.0.0.1）。
  const DEFAULT_TOKEN = "51cffbd1902195784cd69663e49ca8e977decf9f3a4e545c80454c5de96cb76d";
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const validToken = (value) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
  function bytes(value) {
    if (!validToken(value)) throw new Error("Expected 32 bytes encoded as 64 hexadecimal characters");
    return Uint8Array.from(value.match(/../g), (v) => parseInt(v, 16));
  }
  function createNonce() {
    return hex(cryptoApi.getRandomValues(new Uint8Array(32)));
  }
  function payload(role, side, serverNonce, clientNonce) {
    if (!["extension", "client"].includes(role) || !["server", "client"].includes(side)) {
      throw new Error("Invalid authentication role");
    }
    if (!validToken(serverNonce) || !validToken(clientNonce)) throw new Error("Invalid authentication nonce");
    return new TextEncoder().encode(JSON.stringify([PROTOCOL, role, side, serverNonce, clientNonce]));
  }
  async function key(token, use) {
    return cryptoApi.subtle.importKey("raw", bytes(token), { name: "HMAC", hash: "SHA-256" }, false, [use]);
  }
  async function sign(token, role, side, serverNonce, clientNonce) {
    const data = payload(role, side, serverNonce, clientNonce);
    return hex(new Uint8Array(await cryptoApi.subtle.sign("HMAC", await key(token, "sign"), data)));
  }
  async function verify(token, role, side, serverNonce, clientNonce, proof) {
    if (!validToken(proof)) return false;
    try {
      return await cryptoApi.subtle.verify("HMAC", await key(token, "verify"), bytes(proof), payload(role, side, serverNonce, clientNonce));
    } catch (_) { return false; }
  }
  return { PROTOCOL, DEFAULT_TOKEN, validToken, createNonce, sign, verify };
});
