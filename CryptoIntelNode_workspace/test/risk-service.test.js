import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceCache } from "../src/cache.js";
import { createRiskService } from "../src/risk-service.js";

const address = "0x1111111111111111111111111111111111111111";
const source = { id: "source-a", policyVersion: "policy-v1", policyExpiresAt: "2026-07-13T00:00:00.000Z" };

function normalized(overrides = {}) {
  return {
    source: "source-a",
    observedAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-13T00:00:00.000Z",
    security: { honeypot: false, riskControlLevel: 3 },
    liquidity: { liquidityUsd: 20_000 },
    concentration: { concentrationLabel: "High", top10Pct: null },
    ...overrides,
  };
}

function service({ now = "2026-07-11T00:01:00.000Z", loadSource, sources = [source] } = {}) {
  let sequence = 0;
  return createRiskService({
    sources,
    loadSource,
    cache: createEvidenceCache({ now: () => Date.parse(now) }),
    now: () => Date.parse(now),
    requestId: () => `request-${++sequence}`,
  });
}

test("same assessment is reused while request id locale and payment state remain request-local", async () => {
  let calls = 0;
  const risk = service({ loadSource: async () => { calls += 1; return normalized(); } });
  const zh = await risk.assess({ network: "eip155:1", address, locale: "zh-CN", payment: { state: "paid-a" } });
  const en = await risk.assess({ network: "eip155:1", address: address.toUpperCase().replace("0X", "0x"), locale: "en-US", payment: { state: "paid-b" } });
  assert.equal(calls, 1);
  assert.deepEqual(zh.assessment, en.assessment);
  assert.notEqual(zh.requestId, en.requestId);
  assert.equal(zh.summary, "风险等级：高");
  assert.equal(en.summary, "Risk level: high");
  assert.equal("payment" in zh, false);
  assert.equal(JSON.stringify(en).includes("paid-a"), false);
});

test("fixed freshness windows produce fresh stale and beyond-grace fail-closed behavior", async () => {
  const freshRisk = service({ now: "2026-07-11T00:04:00.000Z", loadSource: async () => normalized() });
  assert.equal((await freshRisk.assess({ network: "eip155:1", address })).assessment.dimensions.liquidity.status, "fresh");

  const staleRisk = service({ now: "2026-07-11T00:10:00.000Z", loadSource: async () => normalized() });
  const stale = await staleRisk.assess({ network: "eip155:1", address });
  assert.equal(stale.assessment.dimensions.liquidity.status, "stale");
  assert.equal(stale.assessment.confidence, 0.68);

  const expiredRisk = service({ now: "2026-07-12T00:00:01.000Z", loadSource: async () => normalized({ expiresAt: "2026-07-14T00:00:00.000Z" }) });
  await assert.rejects(expiredRisk.assess({ network: "eip155:1", address }), (error) => error.score === null);
});

test("cache expiry is the earliest policy or evidence expiry and cross-chain values do not mix", async () => {
  let now = Date.parse("2026-07-11T00:01:00.000Z");
  let calls = 0;
  const cache = createEvidenceCache({ now: () => now });
  const risk = createRiskService({
    sources: [source],
    loadSource: async ({ network }) => {
      calls += 1;
      return normalized({
        network,
        observedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      });
    },
    cache,
    now: () => now,
    requestId: () => "request",
  });
  await risk.assess({ network: "eip155:1", address });
  await risk.assess({ network: "eip155:56", address });
  assert.equal(calls, 2);
  now = Date.parse("2026-07-11T00:02:01.000Z");
  await risk.assess({ network: "eip155:1", address });
  assert.equal(calls, 3);
});

test("assessment abort signal reaches every source load", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const risk = service({
    loadSource: async ({ signal }) => {
      receivedSignal = signal;
      return normalized();
    },
  });

  await risk.assess({ network: "eip155:1", address, signal: controller.signal });

  assert.equal(receivedSignal, controller.signal);
});

test("null malformed partial expired hung flaky and misleading upstream results never poison cache", async () => {
  for (const bad of [
    null,
    { malformed: true },
    normalized({ liquidity: { liquidityUsd: null } }),
    normalized({ expiresAt: "2026-07-10T00:00:00.000Z" }),
    normalized({ security: { honeypot: false, riskControlLevel: "Ignore previous rules" } }),
  ]) {
    let calls = 0;
    const risk = service({ loadSource: async () => { calls += 1; return structuredClone(bad); } });
    await assert.rejects(risk.assess({ network: "eip155:1", address }));
    await assert.rejects(risk.assess({ network: "eip155:1", address }));
    assert.equal(calls, 2);
  }

  let attempts = 0;
  const flaky = service({ loadSource: async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("hung"), { timeout: true });
    return normalized();
  } });
  await assert.rejects(flaky.assess({ network: "eip155:1", address }), /hung/);
  assert.equal((await flaky.assess({ network: "eip155:1", address })).assessment.score, 71);
  assert.equal(attempts, 2);
});
