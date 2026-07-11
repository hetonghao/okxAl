const DEFAULT_POLICY = Object.freeze({ activeLimit: 4, queueLimit: 16, queueWaitMs: 500 });

export class AdmissionError extends Error {
  constructor(message, { status = 503, retryAfter = 1 } = {}) {
    super(message);
    this.name = "AdmissionError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function parsePolicy(policy) {
  const parsed = { ...DEFAULT_POLICY, ...policy };
  for (const key of ["activeLimit", "queueLimit", "queueWaitMs"]) {
    if (!Number.isInteger(parsed[key]) || parsed[key] < (key === "queueLimit" ? 0 : 1)) {
      throw new TypeError(`${key} must be a valid integer`);
    }
  }
  return parsed;
}

export function createAdmissionControl(options = {}) {
  const policy = parsePolicy(options);
  const clock = options.clock ?? globalThis;
  const queue = [];
  let active = 0;

  const removeQueued = (entry) => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.cancel);
  };

  const start = (entry) => {
    active += 1;
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.cancel);
    const controller = new AbortController();
    const abort = () => controller.abort(entry.signal.reason);
    entry.signal?.addEventListener("abort", abort, { once: true });
    if (entry.signal?.aborted) abort();

    const cancelled = new Promise((_, reject) => controller.signal.addEventListener(
      "abort", () => reject(controller.signal.reason), { once: true },
    ));
    let operation;
    try {
      operation = Promise.resolve(entry.work({ signal: controller.signal }));
    } catch (error) {
      operation = Promise.reject(error);
    }

    Promise.race([operation, cancelled]).then(entry.resolve, entry.reject);
    const release = () => {
      entry.signal?.removeEventListener("abort", abort);
      active -= 1;
      const next = queue.shift();
      if (next) start(next);
    };
    operation.then(release, release);
  };

  return {
    run(work, { signal } = {}) {
      if (typeof work !== "function") return Promise.reject(new TypeError("work must be a function"));
      if (signal?.aborted) return Promise.reject(signal.reason);

      return new Promise((resolve, reject) => {
        const entry = { work, signal, resolve, reject, timer: undefined, cancel: undefined };
        if (active < policy.activeLimit) {
          start(entry);
          return;
        }
        if (queue.length >= policy.queueLimit) {
          reject(new AdmissionError("admission capacity exceeded"));
          return;
        }

        entry.cancel = () => {
          removeQueued(entry);
          reject(signal.reason);
        };
        entry.timer = clock.setTimeout(() => {
          removeQueued(entry);
          reject(new AdmissionError("queue wait exceeded"));
        }, policy.queueWaitMs);
        signal?.addEventListener("abort", entry.cancel, { once: true });
        queue.push(entry);
      });
    },
    snapshot: () => ({
      active,
      queued: queue.length,
      accepting: active < policy.activeLimit || queue.length < policy.queueLimit,
    }),
    readiness({ quotaAvailable = true } = {}) {
      if (typeof quotaAvailable !== "boolean") throw new TypeError("quotaAvailable must be a boolean");
      return { status: quotaAvailable && active === 0 && queue.length < policy.queueLimit ? 200 : 503 };
    },
    liveness: () => ({ status: 200 }),
  };
}
