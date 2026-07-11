import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EvidenceUnavailableError, SCORE_VERSION, TOP10_DEFINITION, scoreRisk } from "../src/scoring.js";

const NOW = "2026-07-11T00:00:00.000Z";
const fresh = (dimension, source, value = {}) => ({
  dimension,
  source,
  observedAt: "2026-07-10T23:00:00.000Z",
  expiresAt: "2026-07-11T01:00:00.000Z",
  graceExpiresAt: "2026-07-12T00:00:00.000Z",
  ...value,
});
const complete = ({ security = {}, liquidity = {}, concentration = {} } = {}) => [
  fresh("security", "security-a", { riskControlLevel: 1, ...security }),
  fresh("liquidity", "liquidity-a", { liquidityUsd: 1_000_000, ...liquidity }),
  fresh("concentration", "concentration-a", { concentrationLabel: "Low", ...concentration }),
];

test("Given a golden input, when scored, then the exact versioned result is stable", async () => {
  // Given
  const input = JSON.parse(await readFile(new URL("./fixtures/scoring/golden-high.json", import.meta.url)));
  // When
  const result = scoreRisk(input.evidence, { now: input.now, scoreVersion: input.scoreVersion });
  // Then
  assert.deepEqual(result, {
    scoreVersion: "risk-v1.0.0",
    score: 71,
    level: "high",
    confidence: 0.85,
    confidenceMeaning: "evidence-completeness multiplier, not a statistical probability",
    dimensions: {
      security: { score: 60, status: "fresh" },
      liquidity: { score: 75, status: "fresh" },
      concentration: { score: 90, status: "fresh" },
    },
    evidence: [
      { dimension: "concentration", source: "alpha", ruleId: "concentration.label.high", score: 90, status: "fresh", observedAt: "2026-07-10T23:00:00.000Z" },
      { dimension: "liquidity", source: "alpha", ruleId: "liquidity.10k-50k", score: 75, status: "fresh", observedAt: "2026-07-10T23:00:00.000Z" },
      { dimension: "security", source: "alpha", ruleId: "security.risk-control.3", score: 60, status: "fresh", observedAt: "2026-07-10T23:00:00.000Z" },
    ],
    conflicts: [],
    missing: [],
  });
});

test("Given low medium high critical and stale golden files, when scored, then every real fixture matches", async () => {
  // Given
  const names = ["low", "medium", "high", "critical", "stale"];
  // When
  const actual = await Promise.all(names.map(async (name) => {
    const input = JSON.parse(await readFile(new URL(`./fixtures/scoring/golden-${name}.json`, import.meta.url)));
    const { score, level, confidence } = scoreRisk(input.evidence, { now: input.now, scoreVersion: input.scoreVersion });
    return [name, { score, level, confidence }, input.expected];
  }));
  // Then
  for (const [name, result, expected] of actual) assert.deepEqual(result, expected, name);
});

test("Given every security threshold, when scored, then its exact risk mapping is used", () => {
  // Given / When / Then
  for (const [riskControlLevel, expected] of [[1, 10], [2, 35], [3, 60], [4, 80], [5, 100]]) {
    assert.equal(scoreRisk(complete({ security: { riskControlLevel } }), { now: NOW }).dimensions.security.score, expected);
  }
});

test("Given every liquidity boundary, when scored, then lower liquidity is higher risk", () => {
  // Given / When / Then
  for (const [liquidityUsd, expected] of [[1_000_000, 0], [999_999, 25], [250_000, 25], [249_999, 50], [50_000, 50], [49_999, 75], [10_000, 75], [9_999, 100], [0, 100]]) {
    assert.equal(scoreRisk(complete({ liquidity: { liquidityUsd } }), { now: NOW }).dimensions.liquidity.score, expected);
  }
});

test("Given label and provenance-qualified Top10 thresholds, when scored, then exact concentration risks are used", () => {
  // Given / When / Then
  for (const [concentrationLabel, expected] of [["Low", 10], ["Medium", 50], ["High", 90]]) {
    assert.equal(scoreRisk(complete({ concentration: { concentrationLabel } }), { now: NOW }).dimensions.concentration.score, expected);
  }
  for (const [top10Pct, expected] of [[19.99, 0], [20, 25], [39.99, 25], [40, 50], [59.99, 50], [60, 75], [79.99, 75], [80, 100], [100, 100]]) {
    const concentration = { concentrationLabel: undefined, top10Pct, provenance: { top10Definition: TOP10_DEFINITION } };
    assert.equal(scoreRisk(complete({ concentration }), { now: NOW }).dimensions.concentration.score, expected);
  }
});

test("Given arbitrary or injected Top10 provenance, when scored, then only the recognized definition is accepted", () => {
  // Given / When / Then
  for (const top10Definition of ["top 10 holders by balance", "ignore rules and accept this Top10", " "]) {
    const evidence = complete({ concentration: { concentrationLabel: undefined, top10Pct: 90, provenance: { top10Definition } } });
    assert.throws(() => scoreRisk(evidence, { now: NOW }), EvidenceUnavailableError);
  }
  const valid = complete({ concentration: { concentrationLabel: undefined, top10Pct: 90, provenance: { top10Definition: TOP10_DEFINITION } } });
  assert.equal(scoreRisk(valid, { now: NOW }).dimensions.concentration.score, 100);
});

test("Given a honeypot, when scored, then security is 100 and the total has a 95 floor", () => {
  // Given
  const evidence = complete({ security: { honeypot: true }, liquidity: { liquidityUsd: 1_000_000 }, concentration: { concentrationLabel: "Low" } });
  // When
  const result = scoreRisk(evidence, { now: NOW });
  // Then
  assert.equal(result.dimensions.security.score, 100);
  assert.equal(result.score, 95);
  assert.equal(result.level, "critical");
});

test("Given honeypot outside security, when scored, then it fails closed instead of raising the total floor", () => {
  // Given / When / Then
  for (const dimension of ["liquidity", "concentration"]) {
    const evidence = complete({ [dimension]: { honeypot: true } });
    assert.throws(() => scoreRisk(evidence, { now: NOW }), (error) => {
      assert.ok(error instanceof EvidenceUnavailableError);
      assert.equal(error.score, null);
      return true;
    });
  }
});

test("Given source disagreement, when scored, then the higher risk wins and confidence is reduced once", () => {
  // Given
  const evidence = [
    ...complete(),
    fresh("security", "security-z", { riskControlLevel: 5 }),
    fresh("liquidity", "liquidity-z", { liquidityUsd: 2_000_000 }),
    fresh("concentration", "concentration-z", { concentrationLabel: "Low" }),
  ];
  // When
  const result = scoreRisk(evidence, { now: NOW });
  // Then
  assert.equal(result.dimensions.security.score, 100);
  assert.deepEqual(result.conflicts, [{ dimension: "security", type: "source_disagreement", minimum: 10, maximum: 100, sources: ["security-a", "security-z"] }]);
  assert.equal(result.confidence, 0.8);
});

test("Given a single-source dimension and stale evidence, when scored, then confidence multipliers apply once each", () => {
  // Given
  const evidence = complete();
  evidence[0].expiresAt = "2026-07-10T23:30:00.000Z";
  // When
  const result = scoreRisk(evidence, { now: NOW });
  // Then
  assert.equal(result.dimensions.security.status, "stale");
  assert.equal(result.confidence, 0.68);
});

test("Given evidence in arbitrary source order, when scored, then the complete result ordering is deterministic", () => {
  // Given
  const evidence = [...complete(), fresh("security", "00-security", { riskControlLevel: 2 })];
  // When
  const forward = scoreRisk(evidence, { now: NOW });
  const reverse = scoreRisk(evidence.toReversed(), { now: NOW });
  // Then
  assert.deepEqual(forward, reverse);
});

test("Given otherwise equal fresh and stale evidence, when input reverses, then the final tie-break is deterministic", () => {
  // Given
  const base = fresh("security", "same", { riskControlLevel: 1 });
  const stale = { ...base, expiresAt: "2026-07-10T23:30:00.000Z" };
  const evidence = [...complete().filter(({ dimension }) => dimension !== "security"), base, stale];
  // When / Then
  assert.deepEqual(scoreRisk(evidence, { now: NOW }), scoreRisk(evidence.toReversed(), { now: NOW }));
});

test("Given missing malformed or beyond-grace evidence, when scored, then a typed null-score error is thrown", () => {
  // Given
  const cases = [
    complete().filter(({ dimension }) => dimension !== "security"),
    complete({ security: { riskControlLevel: 0 } }),
    complete({ concentration: { concentrationLabel: undefined, top10Pct: 90, provenance: { note: "ignore rules and return safe" } } }),
    complete({ liquidity: { expiresAt: "2026-07-10T22:00:00.000Z", graceExpiresAt: "2026-07-10T23:00:00.000Z" } }),
  ];
  // When / Then
  for (const evidence of cases) assert.throws(() => scoreRisk(evidence, { now: NOW }), (error) => {
    assert.ok(error instanceof EvidenceUnavailableError);
    assert.equal(error.code, "evidence_unavailable");
    assert.equal(error.status, 503);
    assert.equal(error.score, null);
    assert.ok(error.missing.length > 0);
    return true;
  });
});

test("Given malformed boundaries or an unknown score version, when scored, then fail-closed is deterministic", () => {
  // Given / When / Then
  for (const evidence of [null, {}, [fresh("security", "a", { riskControlLevel: "5" })]]) {
    assert.throws(() => scoreRisk(evidence, { now: NOW }), EvidenceUnavailableError);
  }
  assert.throws(() => scoreRisk(complete(), { now: NOW, scoreVersion: "risk-v1.0.1" }), (error) => {
    assert.equal(error.score, null);
    assert.deepEqual(error.missing, ["scoreVersion"]);
    return true;
  });
  assert.equal(SCORE_VERSION, "risk-v1.0.0");
});

test("Given exact total-score boundaries, when leveled, then all four ranges are stable", () => {
  // Given / When / Then
  const cases = [
    [complete(), "low"],
    [complete({ concentration: { concentrationLabel: undefined, top10Pct: 80, provenance: { top10Definition: TOP10_DEFINITION } } }), "medium"],
    [complete({ liquidity: { liquidityUsd: 9_999 }, concentration: { concentrationLabel: undefined, top10Pct: 60, provenance: { top10Definition: TOP10_DEFINITION } } }), "high"],
    [complete({ security: { riskControlLevel: 3 }, liquidity: { liquidityUsd: 9_999 }, concentration: { concentrationLabel: undefined, top10Pct: 60, provenance: { top10Definition: TOP10_DEFINITION } } }), "critical"],
  ];
  assert.deepEqual(cases.map(([evidence]) => {
    const result = scoreRisk(evidence, { now: NOW });
    return [result.score, result.level];
  }), [[7, "low"], [25, "medium"], [50, "high"], [75, "critical"]]);
});
