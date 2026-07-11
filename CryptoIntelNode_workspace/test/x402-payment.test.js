import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import express from "express";

import { createAdmissionControl } from "../src/admission.js";
import { createApp } from "../src/app.js";
import { createPaymentJournal } from "../src/payment-journal.js";
import { assertApprovedRequirements, createX402Payment, paymentConfigReasons } from "../src/payment.js";
import { startServer } from "../src/server.js";

const network = "eip155:196";
const contract = "0x1111111111111111111111111111111111111111";
const payTo = "0x2222222222222222222222222222222222222222";
const address = "0x3333333333333333333333333333333333333333";
const query = `network=eip155%3A196&address=${address}&locale=en-US`;

function approved(overrides = {}) {
  return {
    listingFee: "0.02",
    runtimePrice: "$0.02",
    settlementCostUsd: 0.001,
    status: "approved",
    approvedBy: "finance@example.invalid",
    approvedAt: "2026-07-10T00:00:00.000Z",
    expiresAt: "2026-08-10T00:00:00.000Z",
    tuple: { network, contract, decimals: 6, amountAtomic: "20000", payTo, symbol: "SYNTH", ...overrides.tuple },
    a2aQuote: { mode: "separate", status: "not-configured" },
    ...overrides,
  };
}

function requirements(overrides = {}) {
  return {
    scheme: "exact", network, asset: contract, amount: "20000", payTo,
    maxTimeoutSeconds: 300, extra: { decimals: 6, symbol: "SYNTH" }, ...overrides,
  };
}

test("Given payment approval, when any tuple field is absent or malformed, then it blocks before SDK construction", () => {
  assert.deepEqual(paymentConfigReasons(approved(), "2026-07-11T00:00:00.000Z"), []);
  for (const [field, value] of [
    ["network", null], ["contract", "0x0"], ["decimals", -1], ["amountAtomic", "0"], ["payTo", "0x0"], ["symbol", ""],
  ]) assert(paymentConfigReasons(approved({ tuple: { [field]: value } }), "2026-07-11T00:00:00.000Z").length > 0, field);
  assert(paymentConfigReasons(approved({ status: "pending" }), "2026-07-11T00:00:00.000Z").length > 0);
  assert(paymentConfigReasons(approved({ approvedBy: null }), "2026-07-11T00:00:00.000Z").length > 0);
  assert(paymentConfigReasons(approved({ expiresAt: "2026-07-10T00:00:00.000Z" }), "2026-07-11T00:00:00.000Z").length > 0);
});

test("Given blocked payment config, when construction is attempted, then no SDK object is created", async () => {
  let constructions = 0;
  class Forbidden { constructor() { constructions += 1; } }
  await assert.rejects(createX402Payment({
    config: approved({ status: "pending" }), facilitatorClient: {}, journal: {},
    now: "2026-07-11T00:00:00.000Z",
    dependencies: { x402ResourceServer: Forbidden, ExactEvmScheme: Forbidden, x402HTTPResourceServer: Forbidden },
  }), /payment blocked/);
  assert.equal(constructions, 0);
});

test("Given a hung facilitator startup probe, when its startup deadline expires, then construction fails closed and aborts the probe", async () => {
  // Given
  let aborted = false;
  const stalled = {
    getSupported: ({ signal } = {}) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  };

  // When
  const pending = createX402Payment({
    config: approved(), facilitatorClient: stalled, journal: {},
    now: "2026-07-11T00:00:00.000Z", startupTimeoutMs: 20,
  });

  // Then
  await assert.rejects(pending, { name: "TimeoutError", message: "getSupported deadline exceeded" });
  assert.equal(aborted, true);
});

test("Given the real payment readiness file, when inspected, then it remains blocked without an asset choice", async () => {
  const config = JSON.parse(await readFile(new URL("../readiness/payment.json", import.meta.url), "utf8"));
  assert.equal(config.status, "pending");
  assert(paymentConfigReasons(config).length > 0);
  assert.deepEqual(config.tuple, { network: null, contract: null, decimals: null, amountAtomic: null, payTo: null, symbol: null });
});

test("Given generated requirements, when any approved tuple field differs, then it fails closed", () => {
  assert.doesNotThrow(() => assertApprovedRequirements(approved(), [requirements()]));
  for (const changed of [
    { network: "eip155:1" }, { asset: payTo }, { amount: "2" }, { payTo: contract },
    { extra: { decimals: 18, symbol: "SYNTH" } }, { extra: { decimals: 6, symbol: "USDT" } },
  ]) assert.throws(() => assertApprovedRequirements(approved(), [requirements(changed)]), /payment tuple mismatch/);
  assert.throws(() => assertApprovedRequirements(approved(), []), /payment tuple mismatch/);
  assert.throws(() => assertApprovedRequirements(approved(), [requirements({ scheme: "upto" })]), /payment tuple mismatch/);
});

function facilitator(calls) {
  return {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network, extra: {} }], extensions: [] }),
    verify: async (payload) => {
      calls.verify += 1;
      return payload.payload?.valid === true ? { isValid: true, payer: address } : { isValid: false, invalidReason: "invalid" };
    },
    settle: async () => {
      calls.settlement += 1;
      return { success: true, status: "success", transaction: `0x${"a".repeat(64)}`, network, payer: address };
    },
  };
}

function signature(valid = true) {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: requirements(),
    payload: { valid },
  })).toString("base64");
}

function assessment() {
  const evidence = [
    ["security", 60], ["liquidity", 75], ["concentration", 90],
  ].map(([dimension, score]) => ({ dimension, score, source: "synthetic", ruleId: `${dimension}-rule`, status: "fresh", observedAt: "2026-07-11T00:00:00.000Z", expiresAt: "2026-07-11T01:00:00.000Z" }));
  return { requestId: "request-1", locale: "en-US", asset: { network, address }, assessment: { scoreVersion: "risk-v1.0.0", score: 71, level: "high", confidence: 0.85, dimensions: Object.fromEntries(evidence.map(({ dimension, score }) => [dimension, { score, status: "fresh" }])), evidence, missing: [], conflicts: [] } };
}

test("Given an official synthetic payment, when requested and replayed, then 402 becomes 200 and settlement stays at one", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "crypto-intel-x402-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = { handler: 0, verify: 0, settlement: 0 };
  const paymentMiddleware = await createX402Payment({ config: approved(), facilitatorClient: facilitator(calls), journal: createPaymentJournal({ stateDir }), now: "2026-07-11T00:00:00.000Z" });
  const app = createApp({
    admission: createAdmissionControl(), paymentMiddleware,
    gateReader: async () => ({ source: { status: 200 }, payment: { status: 200 }, economics: { status: 200 } }),
    readinessChecks: { cache: async () => ({ status: 200 }), journal: async () => ({ status: 200 }), spool: async () => ({ status: 200, blockers: [] }) },
    riskService: { assess: async () => { calls.handler += 1; return assessment(); } }, logger: () => {},
  });
  const server = await startServer({ app, port: 0 });
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}/v1/token-risk-score?${query}`;

  const unpaid = await fetch(base);
  assert.equal(unpaid.status, 402);
  assert(unpaid.headers.get("payment-required"));
  assert.deepEqual(calls, { handler: 0, verify: 0, settlement: 0 });

  const headers = { "payment-signature": signature() };
  const paid = await fetch(base, { headers });
  const paidBody = await paid.json();
  assert.equal(paid.status, 200);
  assert.deepEqual(calls, { handler: 1, verify: 1, settlement: 1 });

  const replay = await fetch(base, { headers });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), paidBody);
  assert.deepEqual(calls, { handler: 1, verify: 1, settlement: 1 });
  const identity = createPaymentJournal({ stateDir }).identify(signature(), {
    method: "GET", path: "/v1/token-risk-score", query: { network, address, locale: "en-US" },
  });
  assert.equal((await readFile(join(identity.directory, "state.json"), "utf8")).includes(signature()), false);
});

test("Given an invalid signature, when requested, then handler and settlement remain zero", async () => {
  const calls = { handler: 0, verify: 0, settlement: 0 };
  const middleware = await createX402Payment({ config: approved(), facilitatorClient: facilitator(calls), journal: { replay: async () => null }, now: "2026-07-11T00:00:00.000Z" });
  const app = express();
  app.use(middleware);
  app.get("/v1/token-risk-score", (_request, response) => { calls.handler += 1; response.json({ ok: true }); });
  const server = await startServer({ app, port: 0 });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/token-risk-score`, { headers: { "payment-signature": signature(false) } });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(response.status, 402);
  assert.deepEqual(calls, { handler: 0, verify: 1, settlement: 0 });
});

for (const phase of ["verify", "settle"]) {
  test(`Given a hung ${phase}, when its deadline expires, then admission releases only after the facilitator aborts`, async (context) => {
    const stateDir = await mkdtemp(join(tmpdir(), `crypto-intel-${phase}-timeout-`));
    context.after(() => rm(stateDir, { recursive: true, force: true }));
    let aborted = false;
    const stalled = facilitator({ verify: 0, settlement: 0 });
    stalled[phase] = (...args) => new Promise((_, reject) => {
      const signal = args.at(-1)?.signal;
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    });
    const admission = createAdmissionControl({ activeLimit: 1, queueLimit: 0 });
    const paymentMiddleware = await createX402Payment({
      config: approved(), facilitatorClient: stalled, journal: createPaymentJournal({ stateDir }),
      now: "2026-07-11T00:00:00.000Z", timeoutMs: 20,
    });
    const app = createApp({
      admission, paymentMiddleware,
      gateReader: async () => ({ source: { status: 200 }, payment: { status: 200 }, economics: { status: 200 } }),
      readinessChecks: { cache: async () => ({ status: 200 }), journal: async () => ({ status: 200 }), spool: async () => ({ status: 200, blockers: [] }) },
      riskService: { assess: async () => assessment() }, logger: () => {},
    });
    const server = await startServer({ app, port: 0 });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/token-risk-score?${query}`, {
      headers: { "payment-signature": signature() },
    });

    assert.equal(response.status, 402);
    assert.equal(aborted, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, accepting: true });
  });
}

test("Given a hung payment verification, when the client disconnects, then its abort reaches the facilitator before admission releases", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "crypto-intel-payment-disconnect-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  let verificationStarted;
  const started = new Promise((resolve) => { verificationStarted = resolve; });
  let facilitatorAborted;
  const aborted = new Promise((resolve) => { facilitatorAborted = resolve; });
  const stalled = facilitator({ verify: 0, settlement: 0 });
  stalled.verify = (...args) => new Promise((_, reject) => {
    const signal = args.at(-1)?.signal;
    verificationStarted();
    signal.addEventListener("abort", () => {
      facilitatorAborted();
      reject(signal.reason);
    }, { once: true });
  });
  const admission = createAdmissionControl({ activeLimit: 1, queueLimit: 0 });
  const paymentMiddleware = await createX402Payment({
    config: approved(), facilitatorClient: stalled, journal: createPaymentJournal({ stateDir }),
    now: "2026-07-11T00:00:00.000Z", timeoutMs: 5_000,
  });
  const app = createApp({
    admission, paymentMiddleware,
    gateReader: async () => ({ source: { status: 200 }, payment: { status: 200 }, economics: { status: 200 } }),
    readinessChecks: { cache: async () => ({ status: 200 }), journal: async () => ({ status: 200 }), spool: async () => ({ status: 200, blockers: [] }) },
    riskService: { assess: async () => assessment() }, logger: () => {},
  });
  const server = await startServer({ app, port: 0 });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const client = httpRequest(`http://127.0.0.1:${server.address().port}/v1/token-risk-score?${query}`, {
    headers: { "payment-signature": signature() },
  });
  client.on("error", () => {});
  client.end();
  await started;
  client.destroy();
  await aborted;
  for (let attempts = 0; admission.snapshot().active && attempts < 20; attempts += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, accepting: true });
});
