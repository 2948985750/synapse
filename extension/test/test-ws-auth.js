"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const vm = require("vm");
const auth = require("../src/ws-auth");

(async () => {
  const token = auth.createNonce(), server = auth.createNonce(), client = auth.createNonce();
  const proof = await auth.sign(token, "extension", "client", server, client);
  const expected = crypto.createHmac("sha256", Buffer.from(token, "hex"))
    .update(JSON.stringify([auth.PROTOCOL, "extension", "client", server, client])).digest("hex");
  assert.strictEqual(proof, expected);
  assert(await auth.verify(token, "extension", "client", server, client, proof));
  assert(!await auth.verify(auth.createNonce(), "extension", "client", server, client, proof));
  assert(!await auth.verify(token, "client", "client", server, client, proof));
  assert(!await auth.verify(token, "extension", "server", server, client, proof));
  assert(!await auth.verify(token, "extension", "client", auth.createNonce(), client, proof));
  assert(!await auth.verify(token, "extension", "client", server, auth.createNonce(), proof));
  assert(!await auth.verify(token, "extension", "client", server, client, "malformed"));
  assert.strictEqual(auth.validToken(null), false);
  await assert.rejects(auth.sign("bad-key", "extension", "client", server, client));
  const worker = { crypto: crypto.webcrypto, TextEncoder, Uint8Array };
  vm.runInNewContext(fs.readFileSync(require.resolve("./ws-auth"), "utf8"), worker);
  assert(await worker.WSAuth.verify(token, "extension", "client", server, client, proof));
  const serverProof = await worker.WSAuth.sign(token, "extension", "server", server, client);
  assert(await auth.verify(token, "extension", "server", server, client, serverProof));
  console.log("ALL-WS-AUTH-OK (Node and worker interoperability, forged/replayed/reflected proofs rejected)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
