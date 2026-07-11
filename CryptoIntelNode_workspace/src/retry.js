const DEFAULTS = Object.freeze({ attempts: 2, attemptTimeoutMs: 2_000, deadlineMs: 6_000, backoffMs: 200 });
const NO_AUTO_RETRY = new Set(["settlement", "a2a-ack", "a2a-deliver"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]);

export class RetryTimeoutError extends Error {
  constructor(message = "source attempt timed out") {
    super(message);
    this.name = "RetryTimeoutError";
    this.timeout = true;
  }
}

export function shouldRetry(outcome, operation = "source") {
  if (NO_AUTO_RETRY.has(operation) || outcome?.malformed) return false;
  if (outcome?.timeout || outcome?.name === "AbortError") return true;
  if (NETWORK_CODES.has(outcome?.code)) return true;
  return outcome?.status === 429 || outcome?.status >= 500;
}

function parseOptions(options) {
  const parsed = { ...DEFAULTS, ...options };
  for (const key of ["attempts", "attemptTimeoutMs", "deadlineMs", "backoffMs"]) {
    if (!Number.isInteger(parsed[key]) || parsed[key] < 1) throw new TypeError(`${key} must be a positive integer`);
  }
  if (typeof parsed.random !== "undefined" && typeof parsed.random !== "function") {
    throw new TypeError("random must be a function");
  }
  return parsed;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function runWithTimeout(operation, ms, signal, clock) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = clock.setTimeout(() => controller.abort(new RetryTimeoutError()), ms);
  const cancelled = new Promise((_, reject) => controller.signal.addEventListener(
    "abort", () => reject(controller.signal.reason), { once: true },
  ));
  let pending;
  try {
    pending = Promise.resolve(operation(controller.signal));
  } catch (error) {
    pending = Promise.reject(error);
  }
  return Promise.race([pending, cancelled]).finally(() => {
    clock.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
}

export async function retrySource(operation, options = {}) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  const policy = parseOptions(options);
  const clock = policy.clock ?? { now: Date.now, setTimeout, clearTimeout };
  const now = policy.now ?? clock.now.bind(clock);
  const sleep = policy.sleep ?? defaultSleep;
  const timeout = policy.timeout ?? ((task, ms, signal) => runWithTimeout(task, ms, signal, clock));
  const random = policy.random ?? Math.random;
  const startedAt = now();
  let lastOutcome;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    if (policy.signal?.aborted) throw policy.signal.reason;
    const remaining = policy.deadlineMs - (now() - startedAt);
    if (remaining <= 0) throw new RetryTimeoutError("assessment deadline exceeded");
    try {
      lastOutcome = await timeout(operation, Math.min(policy.attemptTimeoutMs, remaining), policy.signal);
    } catch (error) {
      lastOutcome = error;
    }

    if (!shouldRetry(lastOutcome, policy.operation) || attempt === policy.attempts) {
      if (lastOutcome instanceof Error) throw lastOutcome;
      return lastOutcome;
    }

    const jitter = Math.floor(Math.min(1, Math.max(0, random())) * 100);
    const retryAfter = Math.min(500, Math.max(0, lastOutcome.retryAfterMs ?? 0));
    const delay = Math.max(policy.backoffMs + jitter, retryAfter);
    if (now() - startedAt + delay + policy.attemptTimeoutMs > policy.deadlineMs) break;
    await sleep(delay, policy.signal);
  }

  if (lastOutcome instanceof Error) throw lastOutcome;
  return lastOutcome;
}
