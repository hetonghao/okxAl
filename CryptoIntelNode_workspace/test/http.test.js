import assert from "node:assert/strict";
import test from "node:test";

import { createAdmissionControl } from "../src/admission.js";
import { createApp } from "../src/app.js";
import { startServer } from "../src/server.js";

const address = "0x1111111111111111111111111111111111111111";
const validQuery = `network=eip155%3A1&address=${address}&locale=en-US`;

function assessment() {
  return {
    requestId: "risk-request-1",
    locale: "en-US",
    asset: { network: "eip155:1", address },
    assessment: {
      scoreVersion: "risk-v1.0.0",
      score: 71,
      level: "high",
      confidence: 0.85,
      dimensions: {
        security: { score: 60, status: "fresh" },
        liquidity: { score: 75, status: "fresh" },
        concentration: { score: 90, status: "fresh" },
      },
      evidence: [
        { dimension: "security", source: "synthetic", ruleId: "security-control-3", score: 60, status: "fresh", observedAt: "2026-07-11T00:00:00.000Z", expiresAt: "2026-07-11T06:00:00.000Z" },
        { dimension: "liquidity", source: "synthetic", ruleId: "liquidity-10k-50k", score: 75, status: "fresh", observedAt: "2026-07-11T00:00:00.000Z", expiresAt: "2026-07-11T00:05:00.000Z" },
        { dimension: "concentration", source: "synthetic", ruleId: "concentration-high", score: 90, status: "fresh", observedAt: "2026-07-11T00:00:00.000Z", expiresAt: "2026-07-11T01:00:00.000Z" },
      ],
      missing: [],
      conflicts: [],
    },
  };
}

function readyGates(overrides = {}) {
  return {
    source: { status: 200 },
    payment: { status: 200 },
    economics: { status: 200 },
    ...overrides,
  };
}

async function fixture(context, overrides = {}) {
  const calls = { payment: 0, risk: 0, settlement: 0 };
  const logs = [];
  const admission = overrides.admission ?? createAdmissionControl();
  const app = createApp({
    version: "1.0.0-test",
    admission,
    gateReader: overrides.gateReader ?? (async () => readyGates()),
    readinessChecks: overrides.readinessChecks ?? {
      cache: async () => ({ status: 200 }),
      journal: async () => ({ status: 200 }),
      spool: async () => ({ status: 200, blockers: [] }),
    },
    paymentMiddleware: overrides.paymentMiddleware ?? ((request, response, next) => {
      calls.payment += 1;
      request.payment = { paid: true };
      next();
    }),
    riskService: overrides.riskService ?? {
      assess: async (query) => {
        calls.risk += 1;
        assert.deepEqual(query, { network: "eip155:1", address, locale: "en-US" });
        return assessment();
      },
    },
    logger: (entry) => logs.push(entry),
  });
  const server = await startServer({ app, port: 0 });
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, calls, logs, admission };
}

async function json(response) {
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("Given public probes, when called, then health is free and readiness is layered", async (context) => {
  const service = await fixture(context);
  const health = await json(await fetch(`${service.base}/healthz`, { headers: { authorization: "Bearer secret" } }));
  const ready = await json(await fetch(`${service.base}/readyz`));

  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: "ok", version: "1.0.0-test" });
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body, { status: "ready", blockers: [] });
  assert.deepEqual(service.calls, { payment: 0, risk: 0, settlement: 0 });
});

test("Given each readiness dependency, when it blocks or throws, then readyz fails closed with a stable code", async (context) => {
  const cases = [
    ["source-gate", { gateReader: async () => readyGates({ source: { status: 503 } }) }],
    ["payment-gate", { gateReader: async () => readyGates({ payment: { status: 503 } }) }],
    ["economics-gate", { gateReader: async () => readyGates({ economics: { status: 503 } }) }],
    ["cache-unavailable", { readinessChecks: { cache: async () => ({ status: 503 }), journal: async () => ({ status: 200 }), spool: async () => ({ status: 200, blockers: [] }) } }],
    ["http-journal-unavailable", { readinessChecks: { cache: async () => ({ status: 200 }), journal: async () => { throw new Error("secret path"); }, spool: async () => ({ status: 200, blockers: [] }) } }],
    ["a2a-stale-working", { readinessChecks: { cache: async () => ({ status: 200 }), journal: async () => ({ status: 200 }), spool: async () => ({ status: 503, blockers: ["stale-working"] }) } }],
  ];
  for (const [code, options] of cases) {
    const service = await fixture(context, options);
    const response = await json(await fetch(`${service.base}/readyz`));
    assert.equal(response.status, 503);
    assert(response.body.blockers.includes(code));
  }
});

test("Given invalid query or blocked gates, when requested, then payment and risk are never reached", async (context) => {
  const service = await fixture(context);
  const cases = [
    ["", 400, "missing_parameter"],
    [`network=eip155%3A999&address=${address}`, 422, "unsupported_network"],
    ["network=eip155%3A1&address=0x0", 422, "invalid_address"],
    [`network=eip155%3A1&address=${address}&locale=fr-FR`, 422, "invalid_locale"],
  ];
  for (const [query, status, code] of cases) {
    const response = await json(await fetch(`${service.base}/v1/token-risk-score?${query}`));
    assert.equal(response.status, status);
    assert.equal(response.body.code, code);
    assert.equal(response.body.score, null);
  }
  assert.deepEqual(service.calls, { payment: 0, risk: 0, settlement: 0 });

  const blocked = await fixture(context, { gateReader: async () => readyGates({ payment: { status: 503 } }) });
  const response = await json(await fetch(`${blocked.base}/v1/token-risk-score?${validQuery}`));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal(response.body.code, "payment_gate_blocked");
  assert.deepEqual(blocked.calls, { payment: 0, risk: 0, settlement: 0 });
});

test("Given exhausted admission, when requested, then 503 has Retry-After and no paid work starts", async (context) => {
  const admission = { run: async () => { throw Object.assign(new Error("full"), { name: "AdmissionError", status: 503, retryAfter: 1 }); }, snapshot: () => ({ active: 1, queued: 1, accepting: false }), readiness: () => ({ status: 200 }) };
  const service = await fixture(context, { admission });
  const response = await json(await fetch(`${service.base}/v1/token-risk-score?${validQuery}`));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(service.calls, { payment: 0, risk: 0, settlement: 0 });
});

test("Given a real active request and no queue, when another arrives, then admission rejects before a second payment", async (context) => {
  let release;
  const admission = createAdmissionControl({ activeLimit: 1, queueLimit: 0 });
  const held = admission.run(() => new Promise((resolve) => { release = resolve; }));
  const service = await fixture(context, { admission });
  try {
    const second = await json(await fetch(`${service.base}/v1/token-risk-score?${validQuery}`));
    assert.equal(second.status, 503);
    assert.equal(second.headers.get("retry-after"), "1");
    assert.equal(service.calls.payment, 0);
    assert.equal(service.calls.risk, 0);
  } finally {
    release("done");
  }
  assert.equal(await held, "done");
});

test("Given synthetic ready and fake paid, when requested, then stable v1 output returns and admission releases", async (context) => {
  const service = await fixture(context);
  const response = await json(await fetch(`${service.base}/v1/token-risk-score?${validQuery}`));
  assert.equal(response.status, 200);
  assert.equal(response.body.schemaVersion, "1.0");
  assert.equal(response.body.scoreVersion, "risk-v1.0.0");
  assert.deepEqual(Object.keys(response.body.dimensions), ["security", "liquidity", "concentration"]);
  assert.equal(response.body.freshness.expiresAt, "2026-07-11T00:05:00.000Z");
  assert.deepEqual(service.calls, { payment: 1, risk: 1, settlement: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(service.admission.snapshot(), { active: 0, queued: 0, accepting: true });
});

test("Given payment or risk failures, when response closes, then admission releases and logs keep an allowlist", async (context) => {
  const secret = "payment-signature-super-secret";
  const service = await fixture(context, {
    paymentMiddleware: (request, response, next) => {
      request.headers["payment-signature"] = secret;
      next(new Error("payment exploded with secret"));
    },
  });
  const response = await json(await fetch(`${service.base}/v1/token-risk-score?${validQuery}`, { headers: { cookie: "session=secret" } }));
  assert.equal(response.status, 503);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(service.admission.snapshot(), { active: 0, queued: 0, accepting: true });
  assert(service.logs.length > 0);
  for (const entry of service.logs) {
    assert(Object.keys(entry).every((key) => ["requestId", "route", "status", "duration", "cacheCode", "gateCode"].includes(key)));
  }
  assert.equal(JSON.stringify(service.logs).includes(secret), false);
  assert.equal(JSON.stringify(service.logs).includes("session=secret"), false);
  assert.equal(JSON.stringify(service.logs).includes(address), false);
});
