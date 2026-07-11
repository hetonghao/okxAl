import assert from "node:assert/strict";
import test from "node:test";

import { retrySource, shouldRetry } from "../src/retry.js";

function fakeTime() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      now += ms;
    },
    timeout: async (operation, ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await operation(controller.signal);
        now += Math.min(result.elapsedMs ?? 0, ms);
        return result;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

test("Given 429 then 200, when retried, then exactly two attempts use capped backoff", async () => {
  // Given
  const time = fakeTime();
  let attempts = 0;

  // When
  const result = await retrySource(async () => {
    attempts += 1;
    return attempts === 1
      ? { status: 429, retryAfterMs: 5_000, elapsedMs: 100 }
      : { status: 200, body: "ok", elapsedMs: 100 };
  }, { ...time, random: () => 0 });

  // Then
  assert.equal(result.body, "ok");
  assert.equal(attempts, 2);
  assert.equal(time.now(), 700);
});

test("Given persistent retryable failures, when budgeted, then attempts never exceed two", async () => {
  // Given
  const time = fakeTime();
  let attempts = 0;

  // When
  const result = await retrySource(async () => {
    attempts += 1;
    return { status: 503, elapsedMs: 2_000 };
  }, { ...time, random: () => 1 });

  // Then
  assert.equal(result.status, 503);
  assert.equal(attempts, 2);
  assert(time.now() <= 6_000);
});

test("Given unsafe operations and non-retryable outcomes, when classified, then retry is denied", () => {
  // Given / When / Then
  assert.equal(shouldRetry({ status: 400 }), false);
  assert.equal(shouldRetry({ malformed: true }), false);
  assert.equal(shouldRetry({ status: 503 }, "settlement"), false);
  assert.equal(shouldRetry({ status: 429 }, "a2a-deliver"), false);
  assert.equal(shouldRetry({ code: "ECONNRESET" }), true);
  assert.equal(shouldRetry({ timeout: true }), true);
});

test("Given malformed retry options, when invoked, then they are rejected", async () => {
  // Given / When / Then
  await assert.rejects(retrySource(() => Promise.resolve({ status: 200 }), { attempts: 0 }), /attempts/);
  await assert.rejects(retrySource(null), /operation/);
});

test("Given Retry-After plus another attempt cannot fit, when budgeted, then total deadline is not exceeded", async () => {
  // Given
  const time = fakeTime();
  let attempts = 0;

  // When
  const result = await retrySource(async () => {
    attempts += 1;
    return { status: 429, retryAfterMs: 5_000, elapsedMs: 100 };
  }, {
    ...time,
    attemptTimeoutMs: 100,
    deadlineMs: 650,
    random: () => 1,
  });

  // Then
  assert.equal(result.status, 429);
  assert.equal(attempts, 1);
  assert.equal(time.now(), 100);
});
