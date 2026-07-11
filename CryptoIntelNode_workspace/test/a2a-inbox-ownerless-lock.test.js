import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInboxLocks } from "../a2a/inbox-lock.js";

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "a2a-ownerless-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Given stale ownerless capacity commit and ACK locks When process restarts Then all recover within one attempt", async (t) => {
  const root = await temporaryRoot(t);
  const paths = [
    join(root, ".capacity-lock"),
    join(root, ".capacity-commit-lock"),
    join(root, `0x${"1".repeat(64)}`, ".ack-lock"),
  ];
  const stale = new Date(Date.now() - 101);
  for (const path of paths) {
    await mkdir(path, { recursive: true });
    await utimes(path, stale, stale);
  }

  const restarted = createInboxLocks({ io: fs, staleMs: 100 });
  for (const path of paths) {
    const token = await restarted.acquire(path, { wait: false, expiring: false });
    assert.equal(typeof token, "string");
    assert.equal(await restarted.release(path, token), true);
  }
});

test("Given owner write fails after lock staging directory creation When acquire aborts Then no published or staging lock remains", async (t) => {
  const root = await temporaryRoot(t);
  const path = join(root, ".capacity-lock");
  const faultIo = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") return target[property];
      return async (targetPath, ...args) => {
        if (targetPath.endsWith("owner.json")) {
          const error = new Error("simulated owner write crash");
          error.code = "EIO";
          throw error;
        }
        return target.open(targetPath, ...args);
      };
    },
  });

  await assert.rejects(createInboxLocks({ io: faultIo }).acquire(path), /simulated owner write crash/);

  assert.deepEqual(await readdir(root), []);
  const token = await createInboxLocks({ io: fs }).acquire(path, { wait: false });
  assert.equal(typeof token, "string");
});

test("Given crashed and live ownerless staging directories When process restarts Then only crashed staging is cleaned", async (t) => {
  const root = await temporaryRoot(t);
  const path = join(root, ".capacity-lock");
  const crashed = `${path}.init-999999999-crashed`;
  const live = `${path}.init-${process.pid}-live`;
  await mkdir(crashed);
  await mkdir(live);

  const token = await createInboxLocks({ io: fs }).acquire(path, { wait: false });

  assert.equal(typeof token, "string");
  assert.deepEqual((await readdir(root)).sort(), [".capacity-lock", `.capacity-lock.init-${process.pid}-live`]);
});
