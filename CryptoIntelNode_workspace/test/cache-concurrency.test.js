import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceCache, evidenceCacheKey } from "../src/cache.js";

const keyParts = {
  sourceId: "source-a",
  sourcePolicyVersion: "policy-v1",
  scoreVersion: "risk-v1.0.0",
  network: "eip155:1",
  address: "0x1111111111111111111111111111111111111111",
};

test("100 concurrent misses share one loader and return isolated values", async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const cache = createEvidenceCache({ now: () => 1_000 });
  const load = async () => {
    calls += 1;
    await blocked;
    return { value: { source: "source-a", nested: { value: 1 } }, expiresAt: 2_000 };
  };
  const pending = Array.from({ length: 100 }, () => cache.getOrLoad(evidenceCacheKey(keyParts), load));
  release();
  const values = await Promise.all(pending);
  assert.equal(calls, 1);
  values[0].nested.value = 9;
  assert.equal(values[1].nested.value, 1);
});

test("cache keys isolate source policy score network and normalized address", () => {
  const base = evidenceCacheKey({ ...keyParts, address: keyParts.address.toUpperCase().replace("0X", "0x") });
  assert.equal(base, evidenceCacheKey(keyParts));
  for (const [field, value] of [
    ["sourceId", "source-b"],
    ["sourcePolicyVersion", "policy-v2"],
    ["scoreVersion", "risk-v2"],
    ["network", "eip155:56"],
    ["address", "0x2222222222222222222222222222222222222222"],
  ]) assert.notEqual(base, evidenceCacheKey({ ...keyParts, [field]: value }));
});

test("cache keys do not collide when fields contain separators", async () => {
  const cache = createEvidenceCache({ now: () => 1_000 });
  const firstKey = evidenceCacheKey({ ...keyParts, sourceId: "alpha|policy", sourcePolicyVersion: "v1" });
  const secondKey = evidenceCacheKey({ ...keyParts, sourceId: "alpha", sourcePolicyVersion: "policy|v1" });
  let secondCalls = 0;
  const first = await cache.getOrLoad(firstKey, async () => ({ value: { source: "first" }, expiresAt: 2_000 }));
  const second = await cache.getOrLoad(secondKey, async () => ({ value: { source: "second", calls: ++secondCalls }, expiresAt: 2_000 }));
  assert.deepEqual(first, { source: "first" });
  assert.deepEqual(second, { source: "second", calls: 1 });
  assert.equal(secondCalls, 1);
});

test("expired entries refresh and rejected flights never remain cached", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = createEvidenceCache({ now: () => now });
  const key = evidenceCacheKey(keyParts);
  const load = async () => ({ value: { calls: ++calls }, expiresAt: now + 10 });
  assert.equal((await cache.getOrLoad(key, load)).calls, 1);
  assert.equal((await cache.getOrLoad(key, load)).calls, 1);
  now += 11;
  assert.equal((await cache.getOrLoad(key, load)).calls, 2);

  let failures = 0;
  const flaky = async () => {
    failures += 1;
    if (failures === 1) throw new Error("temporary");
    return { value: { ok: true }, expiresAt: now + 10 };
  };
  await assert.rejects(cache.getOrLoad("flaky", flaky), /temporary/);
  assert.deepEqual(await cache.getOrLoad("flaky", flaky), { ok: true });
  assert.equal(failures, 2);
});

test("LRU is capped at 1000 and dirty oversized unsupported partial values are not cached", async () => {
  const cache = createEvidenceCache({ now: () => 1_000 });
  for (let index = 0; index < 1_001; index += 1) {
    await cache.getOrLoad(`k${index}`, async () => ({ value: { index }, expiresAt: 2_000 }));
  }
  assert.equal(cache.size, 1_000);
  assert.equal(cache.has("k0"), false);
  assert.equal(cache.has("k1000"), true);

  for (const [key, loaded] of [
    ["unsupported", { value: null, expiresAt: 2_000 }],
    ["partial", { value: { partial: true }, expiresAt: 2_000, cacheable: false }],
    ["expired", { value: { ok: true }, expiresAt: 999 }],
    ["oversized", { value: { text: "x".repeat(256 * 1024) }, expiresAt: 2_000 }],
    ["dirty", { value: { unsafe: 1n }, expiresAt: 2_000 }],
  ]) {
    await cache.getOrLoad(key, async () => loaded);
    assert.equal(cache.has(key), false, key);
  }
});
