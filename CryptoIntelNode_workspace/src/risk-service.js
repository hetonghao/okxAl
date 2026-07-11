import { randomUUID } from "node:crypto";

import { createEvidenceCache, evidenceCacheKey } from "./cache.js";
import { SCORE_VERSION, TOP10_DEFINITION, scoreRisk } from "./scoring.js";

const WINDOWS = Object.freeze({
  security: { freshMs: 6 * 60 * 60 * 1_000, graceMs: 24 * 60 * 60 * 1_000 },
  liquidity: { freshMs: 5 * 60 * 1_000, graceMs: 30 * 60 * 1_000 },
  concentration: { freshMs: 60 * 60 * 1_000, graceMs: 6 * 60 * 60 * 1_000 },
});

function validSourceEvidence(value, expectedSource, nowMs) {
  if (!value || typeof value !== "object" || value.source !== expectedSource) return false;
  const observedAt = Date.parse(value.observedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || observedAt > nowMs || expiresAt <= nowMs || observedAt >= expiresAt) return false;
  const security = value.security;
  const liquidity = value.liquidity;
  const concentration = value.concentration;
  const hasSecurity = security && (security.honeypot === true || Number.isInteger(security.riskControlLevel) && security.riskControlLevel >= 1 && security.riskControlLevel <= 5);
  const hasLiquidity = liquidity && Number.isFinite(liquidity.liquidityUsd) && liquidity.liquidityUsd >= 0;
  const hasConcentration = concentration && (["Low", "Medium", "High"].includes(concentration.concentrationLabel)
    || Number.isFinite(concentration.top10Pct) && concentration.top10Pct >= 0 && concentration.top10Pct <= 100
      && concentration.provenance?.top10Definition === TOP10_DEFINITION);
  return Boolean(hasSecurity && hasLiquidity && hasConcentration);
}

function scoringEvidence(value) {
  const observedAt = Date.parse(value.observedAt);
  const sourceExpiry = Date.parse(value.expiresAt);
  return Object.entries(WINDOWS).map(([dimension, window]) => ({
    dimension,
    source: value.source,
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(Math.min(sourceExpiry, observedAt + window.freshMs)).toISOString(),
    graceExpiresAt: new Date(Math.min(sourceExpiry, observedAt + window.graceMs)).toISOString(),
    ...value[dimension],
  }));
}

function localizedSummary(level, locale) {
  return locale === "en-US" ? `Risk level: ${level}` : `风险等级：${{ low: "低", medium: "中", high: "高", critical: "极高" }[level]}`;
}

export function createRiskService({ sources, loadSource, cache = createEvidenceCache(), now = Date.now, requestId = randomUUID } = {}) {
  if (!Array.isArray(sources) || sources.length === 0 || typeof loadSource !== "function") throw new TypeError("sources and loadSource are required");

  async function load(source, network, address) {
    const key = evidenceCacheKey({
      sourceId: source.id,
      sourcePolicyVersion: source.policyVersion,
      scoreVersion: SCORE_VERSION,
      network,
      address,
    });
    return cache.getOrLoad(key, async () => {
      const value = await loadSource({ sourceId: source.id, network, address });
      const current = now();
      if (!validSourceEvidence(value, source.id, current)) throw new TypeError(`${source.id} returned incomplete or invalid evidence`);
      const policyExpiry = Date.parse(source.policyExpiresAt);
      const evidenceExpiry = Date.parse(value.expiresAt);
      if (!Number.isFinite(policyExpiry) || policyExpiry <= current) throw new TypeError(`${source.id} policy is expired`);
      return { value, expiresAt: Math.min(policyExpiry, evidenceExpiry) };
    });
  }

  return {
    async assess({ network, address, locale = "zh-CN" }) {
      if (!new Set(["zh-CN", "en-US"]).has(locale)) throw new TypeError("locale is invalid");
      const normalizedAddress = address?.toLowerCase();
      const values = await Promise.all(sources.map((source) => load(source, network, normalizedAddress)));
      const assessment = scoreRisk(values.flatMap(scoringEvidence), { now: new Date(now()).toISOString() });
      return {
        requestId: requestId(),
        locale,
        asset: { network, address: normalizedAddress },
        assessment,
        summary: localizedSummary(assessment.level, locale),
      };
    },
  };
}
