import assert from "node:assert/strict";
import test from "node:test";

import { createAdmissionControl } from "../src/admission.js";
import { RetryTimeoutError, retrySource } from "../src/retry.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function manualClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const timer = { at: now + ms, callback, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.active = false; },
    advance(ms) {
      now += ms;
      for (const timer of timers.filter((entry) => entry.active && entry.at <= now)) {
        timer.active = false;
        timer.callback();
      }
    },
    pending: () => timers.filter((timer) => timer.active).length,
  };
}

test("Given a never-resolving source, when attempt timeout fires, then work aborts and admission drains", async () => {
  // Given
  const clock = manualClock();
  const admission = createAdmissionControl({ clock });
  let sourceAborted = false;
  const request = admission.run(({ signal }) => retrySource(
    (attemptSignal) => new Promise((_, reject) => attemptSignal.addEventListener("abort", () => {
      sourceAborted = true;
      reject(attemptSignal.reason);
    }, { once: true })),
    { clock, sleep: () => Promise.resolve(), signal },
  ));

  // When
  clock.advance(2_000);
  await tick();
  clock.advance(2_200);

  // Then
  await assert.rejects(request, RetryTimeoutError);
  assert.equal(sourceAborted, true);
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, accepting: true });
  assert.equal(clock.pending(), 0);
});

test("Given a queued request, when queue wait expires, then it fails before upstream starts", async () => {
  // Given
  const clock = manualClock();
  const admission = createAdmissionControl({ activeLimit: 1, queueLimit: 1, queueWaitMs: 500, clock });
  const activeAbort = new AbortController();
  const active = admission.run(({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), { signal: activeAbort.signal });
  let started = false;
  const queued = admission.run(() => { started = true; });

  // When
  clock.advance(500);

  // Then
  await assert.rejects(queued, /queue wait/i);
  assert.equal(started, false);
  assert.equal(admission.readiness().status, 503);
  assert.equal(admission.liveness().status, 200);
  activeAbort.abort(new Error("cleanup"));
  await assert.rejects(active, /cleanup/);
  await Promise.resolve();
  assert.equal(clock.pending(), 0);
});

test("Given repeated client interruption, when aborted, then stale state and timers are removed", async () => {
  // Given
  const clock = manualClock();
  const admission = createAdmissionControl({ clock });

  // When
  for (let index = 0; index < 10; index += 1) {
    const controller = new AbortController();
    const request = admission.run(({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), { signal: controller.signal });
    controller.abort(new Error(`interrupt-${index}`));
    await assert.rejects(request, new RegExp(`interrupt-${index}`));
    await Promise.resolve();
  }

  // Then
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, accepting: true });
  assert.equal(clock.pending(), 0);
});
