import assert from "node:assert/strict";
import test from "node:test";

import { AdmissionError, createAdmissionControl } from "../src/admission.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("Given 100 requests, when admitted, then active and queued work stay bounded", async () => {
  // Given
  const gates = Array.from({ length: 20 }, deferred);
  const admission = createAdmissionControl();
  let started = 0;

  // When
  const requests = Array.from({ length: 100 }, (_, index) => admission.run(
    () => { started += 1; return gates[index]?.promise; },
  ).then((value) => ({ value }), (error) => ({ error })));
  await tick();

  // Then
  assert.deepEqual(admission.snapshot(), { active: 4, queued: 16, accepting: false });
  assert.equal(started, 4);
  const rejected = await Promise.all(requests.slice(20));
  assert(rejected.every(({ error }) => error instanceof AdmissionError && error.status === 503));
  assert(rejected.every(({ error }) => error.retryAfter === 1));

  for (const gate of gates) gate.resolve("ok");
  assert.deepEqual(await Promise.all(requests.slice(0, 20)), Array(20).fill({ value: "ok" }));
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, accepting: true });
});

test("Given queued and active requests, when aborted, then capacity is released", async () => {
  // Given
  const admission = createAdmissionControl({ activeLimit: 1, queueLimit: 1, queueWaitMs: 500 });
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  let underlyingAborted = false;
  const first = admission.run(({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => {
    underlyingAborted = true;
    reject(signal.reason);
  }, { once: true })), { signal: firstAbort.signal });
  const second = admission.run(() => Promise.resolve("never-started"), { signal: secondAbort.signal });
  await tick();

  // When
  secondAbort.abort(new Error("queued-cancel"));
  firstAbort.abort(new Error("active-cancel"));

  // Then
  await assert.rejects(second, /queued-cancel/);
  await assert.rejects(first, /active-cancel/);
  assert.equal(underlyingAborted, true);
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, accepting: true });
});

test("Given malformed policy, when constructed, then it is rejected", () => {
  // Given / When / Then
  assert.throws(() => createAdmissionControl({ activeLimit: 0 }), /activeLimit/);
  assert.throws(() => createAdmissionControl({ queueLimit: -1 }), /queueLimit/);
  assert.throws(() => createAdmissionControl({ queueWaitMs: Number.NaN }), /queueWaitMs/);
});

test("Given exhausted quota, when health is checked, then readiness degrades but liveness stays healthy", () => {
  // Given
  const admission = createAdmissionControl();

  // When
  const readiness = admission.readiness({ quotaAvailable: false });

  // Then
  assert.equal(readiness.status, 503);
  assert.equal(admission.liveness().status, 200);
});
