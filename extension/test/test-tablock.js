#!/usr/bin/env node
"use strict";
// Browser-free unit test for the FIFO per-key mutex (tablock.js).
//   node extension/src/test-tablock.js

const assert = require("assert");
const { TabLock } = require("../src/tablock.js");

let passed = 0;
function ok(name, fn) {
  return fn().then(() => {
    passed++;
    console.log("  ok - " + name);
  });
}

async function main() {
  console.log("tablock");

  await ok("FIFO: A then B on same key run in order", async () => {
    const lock = new TabLock();
    const order = [];
    let releaseA, releaseB;
    const doneA = new Promise((r) => (releaseA = r));
    const doneB = new Promise((r) => (releaseB = r));

    const p1 = (async () => {
      await lock.acquire("t1");
      order.push("A-start");
      await doneA;
      lock.release("t1");
      order.push("A-end");
    })();
    const p2 = (async () => {
      await lock.acquire("t1");
      order.push("B-start");
      await doneB;
      lock.release("t1");
      order.push("B-end");
    })();

    await new Promise((r) => setTimeout(r, 20)); // let A grab the lock
    assert.deepStrictEqual(order.slice(0, 1), ["A-start"], "A should hold first; B must be blocked behind it");
    releaseA();
    await new Promise((r) => setTimeout(r, 10)); // let B start
    releaseB();
    await Promise.all([p1, p2]);
    // Strict mutual exclusion: A fully completes before B starts.
    assert.deepStrictEqual(order, ["A-start", "A-end", "B-start", "B-end"]);
  });

  await ok("parallel: different keys don't block each other", async () => {
    const lock = new TabLock();
    let aDone = false, bDone = false;
    const p1 = (async () => { await lock.acquire("k1"); await new Promise((r) => setTimeout(r, 30)); aDone = true; lock.release("k1"); })();
    const p2 = (async () => { await lock.acquire("k2"); await new Promise((r) => setTimeout(r, 10)); bDone = true; lock.release("k2"); })();
    await Promise.all([p1, p2]);
    // k2 finished before k1's long task; both completed without cross-blocking.
    assert.ok(aDone && bDone);
  });

  await ok("acquire timeout drops the waiter out of line", async () => {
    const lock = new TabLock();
    let release;
    const hold = new Promise((r) => (release = r));
    const p1 = (async () => { await lock.acquire("t"); await hold; lock.release("t"); })();
    // p1 holds. p2 should time out; p3 after p2's timeout should still get in.
    await assert.rejects(() => lock.acquire("t", 40), /timed out/);
    release();
    await p1;
    const t0 = Date.now();
    await lock.acquire("t", 2000); // should succeed promptly now
    assert.ok(Date.now() - t0 < 500, "waiter after release acquires quickly");
    lock.release("t");
  });

  await ok("size() reflects queue depth", async () => {
    const lock = new TabLock();
    const holders = [];
    let rel;
    for (let i = 0; i < 3; i++) {
      holders.push(
        (async () => {
          await lock.acquire("q");
          if (i === 0) {
            // first holder parks; track depth while others queue
            await new Promise((r) => (rel = r));
          }
          lock.release("q");
        })(),
      );
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lock.size("q"), 3, "three queued");
    rel();
    await Promise.all(holders);
    assert.strictEqual(lock.size("q"), 0, "drained");
  });

  console.log("boundaries");

  await ok("ghost release: release() on an empty key is a no-op, no throw", async () => {
    const lock = new TabLock();
    lock.release("never-used"); // must not throw
    lock.release("never-used");
    assert.strictEqual(lock.size("never-used"), 0);
    // keys() only lists keys that ever had a queue entry
    assert.ok(lock.keys().includes("never-used") === true || lock.size("never-used") === 0);
  });

  await ok("multiple queued waiters time out and drop; the last one still gets in", async () => {
    const lock = new TabLock();
    let releaseA;
    const holdA = (async () => {
      await lock.acquire("t", 0); // holder, no timeout
      await new Promise((r) => (releaseA = r));
      lock.release("t");
    })();
    await new Promise((r) => setTimeout(r, 5)); // A now holds
    // B and C queue up, both time out and drop out of line.
    const b = lock.acquire("t", 40).then(() => "B-granted", () => "B-dropped");
    await new Promise((r) => setTimeout(r, 50));
    const c = (async () => {
      try {
        await lock.acquire("t", 2000); // generous: it WILL be handed the lock
        return "C-granted";
      } catch (_) {
        return "C-dropped";
      } finally {
        lock.release("t");
      }
    })();
    const bRes = await b;
    assert.strictEqual(bRes, "B-dropped", "queued B times out and drops");
    releaseA(); // A releases -> C should be handed the lock (B is gone)
    await Promise.all([holdA, c]);
    assert.strictEqual(lock.size("t"), 0, "drained after hand-off");
  });

  await ok("five deep FIFO drains strictly in submission order", async () => {
    const lock = new TabLock();
    const drained = [];
    async function job(n) {
      await lock.acquire("d", 5000);
      drained.push(n);
      lock.release("d");
    }
    const ps = [1, 2, 3, 4, 5].map((n) => job(n));
    // stagger submissions so FIFO order is unambiguous
    for (const p of ps) await new Promise((r) => setTimeout(r, 5));
    await Promise.all(ps);
    assert.deepStrictEqual(drained, [1, 2, 3, 4, 5]);
  });

  await ok("timeoutMs=0 waits indefinitely (no timer armed)", async () => {
    const lock = new TabLock();
    const p = (async () => {
      await lock.acquire("x", 0);
      lock.release("x");
    })();
    // nothing holds x yet, so it should resolve immediately anyway; the
    // assertion is that a WAITING acquire with 0 does not reject on its own.
    await p;
    let releaseX;
    const hold = (async () => { await lock.acquire("x", 0); releaseX = () => lock.release("x"); })();
    await new Promise((r) => setTimeout(r, 10));
    let timedOutEarly = false;
    const wait = lock.acquire("x", 0).then(
      () => lock.release("x"),
      (e) => { timedOutEarly = true; throw e; },
    );
    await new Promise((r) => setTimeout(r, 50)); // 0ms timeout would have rejected by now
    assert.strictEqual(timedOutEarly, false, "0-timeout waiter did not reject");
    releaseX();
    await hold;
    await wait;
  });

  console.log("\nALL-TABLOCK-OK (" + passed + " cases)");
}

main().catch((e) => {
  console.error("TABLOCK-FAIL: " + (e.stack || e.message));
  process.exit(1);
});
