export const SCORE_VERSION = "risk-v1.0.0";
export const TOP10_DEFINITION = "top10-holders-by-balance-excluding-burn-and-lp-v1";

const DIMENSIONS = ["security", "liquidity", "concentration"];
const CONFIDENCE_MEANING = "evidence-completeness multiplier, not a statistical probability";

export class EvidenceUnavailableError extends Error {
  constructor(missing) {
    super(`Required scoring evidence unavailable: ${missing.join(", ")}`);
    this.name = "EvidenceUnavailableError";
    this.code = "evidence_unavailable";
    this.status = 503;
    this.score = null;
    this.missing = [...missing].sort();
  }
}

function securityScore(item) {
  const candidates = [];
  if (item.honeypot === true) candidates.push([100, "security.honeypot"]);
  const mapped = { 1: 10, 2: 35, 3: 60, 4: 80, 5: 100 }[item.riskControlLevel];
  if (mapped !== undefined && Number.isInteger(item.riskControlLevel)) {
    candidates.push([mapped, `security.risk-control.${item.riskControlLevel}`]);
  }
  return candidates.sort(([a], [b]) => b - a)[0] ?? null;
}

function liquidityScore(item) {
  if (!Number.isFinite(item.liquidityUsd) || item.liquidityUsd < 0) return null;
  if (item.liquidityUsd >= 1_000_000) return [0, "liquidity.gte-1m"];
  if (item.liquidityUsd >= 250_000) return [25, "liquidity.250k-1m"];
  if (item.liquidityUsd >= 50_000) return [50, "liquidity.50k-250k"];
  if (item.liquidityUsd >= 10_000) return [75, "liquidity.10k-50k"];
  return [100, "liquidity.lt-10k"];
}

function concentrationScore(item) {
  const candidates = [];
  const label = { Low: 10, Medium: 50, High: 90 }[item.concentrationLabel];
  if (label !== undefined) candidates.push([label, `concentration.label.${item.concentrationLabel.toLowerCase()}`]);
  if (
    Number.isFinite(item.top10Pct)
    && item.top10Pct >= 0
    && item.top10Pct <= 100
    && item.provenance?.top10Definition === TOP10_DEFINITION
  ) {
    if (item.top10Pct < 20) candidates.push([0, "concentration.top10.lt-20"]);
    else if (item.top10Pct < 40) candidates.push([25, "concentration.top10.20-40"]);
    else if (item.top10Pct < 60) candidates.push([50, "concentration.top10.40-60"]);
    else if (item.top10Pct < 80) candidates.push([75, "concentration.top10.60-80"]);
    else candidates.push([100, "concentration.top10.gte-80"]);
  }
  return candidates.sort(([a], [b]) => b - a)[0] ?? null;
}

function parseEvidence(item, nowMs) {
  if (!item || typeof item !== "object" || !DIMENSIONS.includes(item.dimension) || typeof item.source !== "string" || item.source.trim() === "") return null;
  if (item.dimension !== "security" && Object.hasOwn(item, "honeypot")) {
    throw new EvidenceUnavailableError(["honeypot.dimension"]);
  }
  const observedAt = Date.parse(item.observedAt);
  const expiresAt = Date.parse(item.expiresAt);
  const graceExpiresAt = Date.parse(item.graceExpiresAt);
  if (![observedAt, expiresAt, graceExpiresAt].every(Number.isFinite) || observedAt > expiresAt || expiresAt > graceExpiresAt || nowMs > graceExpiresAt) return null;
  const scored = {
    security: securityScore,
    liquidity: liquidityScore,
    concentration: concentrationScore,
  }[item.dimension](item);
  if (!scored) return null;
  const [score, ruleId] = scored;
  return {
    dimension: item.dimension,
    source: item.source,
    ruleId,
    score,
    status: nowMs > expiresAt ? "stale" : "fresh",
    observedAt: new Date(observedAt).toISOString(),
    honeypot: item.honeypot === true,
  };
}

function level(score) {
  if (score < 25) return "low";
  if (score < 50) return "medium";
  if (score < 75) return "high";
  return "critical";
}

function expandEvidence(item) {
  if (!item || typeof item !== "object" || item.dimension !== undefined) return [item];
  return DIMENSIONS.map((dimension) => ({
    ...item,
    ...item[dimension],
    dimension,
    expiresAt: item[dimension]?.expiresAt ?? item.expiresAt,
    graceExpiresAt: item[dimension]?.graceExpiresAt ?? item.graceExpiresAt,
  }));
}

export function scoreRisk(evidence, { now, scoreVersion = SCORE_VERSION } = {}) {
  if (scoreVersion !== SCORE_VERSION) throw new EvidenceUnavailableError(["scoreVersion"]);
  const nowMs = Date.parse(now);
  if (!Array.isArray(evidence) || !Number.isFinite(nowMs)) throw new EvidenceUnavailableError(DIMENSIONS);

  const parsed = evidence.flatMap(expandEvidence).map((item) => parseEvidence(item, nowMs)).filter(Boolean).sort((a, b) => (
    a.dimension.localeCompare(b.dimension)
    || a.source.localeCompare(b.source)
    || a.ruleId.localeCompare(b.ruleId)
    || a.observedAt.localeCompare(b.observedAt)
    || a.score - b.score
    || a.status.localeCompare(b.status)
    || Number(a.honeypot) - Number(b.honeypot)
    || JSON.stringify(a).localeCompare(JSON.stringify(b))
  ));
  const missing = DIMENSIONS.filter((dimension) => !parsed.some((item) => item.dimension === dimension));
  if (missing.length > 0) throw new EvidenceUnavailableError(missing);

  const dimensions = {};
  const conflicts = [];
  let hasSingleSource = false;
  for (const dimension of DIMENSIONS) {
    const items = parsed.filter((item) => item.dimension === dimension);
    const bySource = Map.groupBy(items, ({ source }) => source);
    const scores = [...bySource.values()].map((sourceItems) => Math.max(...sourceItems.map(({ score }) => score)));
    const minimum = Math.min(...scores);
    const maximum = Math.max(...scores);
    const sources = [...bySource.keys()].sort();
    const conflicted = maximum - minimum >= 50;
    if (sources.length === 1) hasSingleSource = true;
    if (conflicted) conflicts.push({ dimension, type: "source_disagreement", minimum, maximum, sources });
    dimensions[dimension] = {
      score: maximum,
      status: conflicted ? "conflicted" : items.some(({ status }) => status === "stale") ? "stale" : "fresh",
    };
  }

  let confidence = 1;
  if (hasSingleSource) confidence *= 0.85;
  if (parsed.some(({ status }) => status === "stale")) confidence *= 0.8;
  if (conflicts.length > 0) confidence *= 0.8;
  const weighted = Math.round(dimensions.security.score * 0.5 + dimensions.liquidity.score * 0.3 + dimensions.concentration.score * 0.2);
  const score = parsed.some(({ dimension, honeypot }) => dimension === "security" && honeypot) ? Math.max(95, weighted) : weighted;

  return {
    scoreVersion: SCORE_VERSION,
    score,
    level: level(score),
    confidence: Math.round(confidence * 100) / 100,
    confidenceMeaning: CONFIDENCE_MEANING,
    dimensions,
    evidence: parsed.map(({ honeypot: _honeypot, ...item }) => item),
    conflicts,
    missing: [],
  };
}
