import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import { retrySource } from "../retry.js";

const DEFAULT_POLICY = new URL("../../readiness/data-sources.json", import.meta.url);
const NETWORKS = new Set(["eip155:1", "eip155:56", "eip155:8453", "eip155:42161", "eip155:196"]);
const LABELS = new Set(["Low", "Medium", "High"]);
const ORIGINS = new Set(["upstream", "derived"]);
const REQUIRED_SOURCE_STRINGS = ["endpoint", "plan", "docsUrl", "termsUrl", "reviewedAt", "attribution"];

export class SourcePolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourcePolicyError";
  }
}

export class SourceDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceDataError";
    this.malformed = true;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function provenanceDigest(evidence) {
  const { provenance: ignored, ...payload } = evidence;
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

export function verifyProvenance(evidence) {
  const digest = evidence?.provenance?.digest;
  if (evidence?.provenance?.algorithm !== "sha256" || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return false;
  try {
    return timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(provenanceDigest(evidence), "hex"));
  } catch {
    return false;
  }
}

function date(value, field) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw new SourceDataError(`${field} is invalid`);
  return { value, milliseconds };
}

function finite(value, field, maximum = Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new SourceDataError(`${field} is invalid`);
  }
  return value;
}

function nullableFinite(value, field, maximum = Infinity) {
  return value === null ? null : finite(value, field, maximum);
}

function normalize(raw, source, network, nowMs) {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SourceDataError("source response is invalid");
  if (typeof raw.network !== "undefined" && raw.network !== network) throw new SourceDataError("source response chain mismatch");

  const observed = date(raw.observedAt, "observedAt");
  const expires = date(raw.expiresAt, "expiresAt");
  if (observed.milliseconds > nowMs || expires.milliseconds <= nowMs || observed.milliseconds >= expires.milliseconds || nowMs - observed.milliseconds > 86_400_000) {
    throw new SourceDataError("source timestamps are stale or invalid");
  }
  if (!ORIGINS.has(raw.timestampOrigin)) throw new SourceDataError("timestampOrigin is invalid");
  if (!raw.security || typeof raw.security !== "object" || (raw.security.honeypot !== null && typeof raw.security.honeypot !== "boolean")) {
    throw new SourceDataError("security.honeypot is invalid");
  }
  if (raw.security.riskControlLevel !== null && (!Number.isInteger(raw.security.riskControlLevel) || raw.security.riskControlLevel < 1 || raw.security.riskControlLevel > 5)) {
    throw new SourceDataError("security.riskControlLevel is invalid");
  }
  if (raw.concentrationLabel !== null && !LABELS.has(raw.concentrationLabel)) throw new SourceDataError("concentrationLabel is invalid");

  const evidence = {
    security: { honeypot: raw.security.honeypot, riskControlLevel: raw.security.riskControlLevel },
    liquidity: { liquidityUsd: nullableFinite(raw.liquidityUsd, "liquidityUsd") },
    concentration: {
      concentrationLabel: raw.concentrationLabel,
      top10Pct: nullableFinite(raw.top10Pct, "top10Pct", 100),
    },
    source,
    observedAt: observed.value,
    timestampOrigin: raw.timestampOrigin,
    expiresAt: expires.value,
  };
  return { ...evidence, provenance: { algorithm: "sha256", digest: provenanceDigest(evidence) } };
}

function approvedSource(policy, sourceId, network, nowMs) {
  const source = Array.isArray(policy?.sources) ? policy.sources.find((candidate) => candidate?.id === sourceId) : null;
  if (!source || source.status !== "approved" || typeof source.approvedBy !== "string" || /^(unknown|pending)?$/i.test(source.approvedBy.trim())) {
    throw new SourcePolicyError(`${sourceId} is not approved`);
  }
  const approvedAt = Date.parse(source.approvedAt);
  const expiresAt = Date.parse(source.expiresAt);
  if (!Number.isFinite(approvedAt) || approvedAt > nowMs) throw new SourcePolicyError(`${sourceId} approval timestamp is invalid`);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs || expiresAt <= approvedAt) throw new SourcePolicyError(`${sourceId} approval expired`);
  for (const field of ["commercialServerUse", "derivativePaidOutput", "cache", "realFixtureRetention"]) {
    if (source[field] !== "yes") throw new SourcePolicyError(`${sourceId}.${field} is not approved`);
  }
  for (const field of REQUIRED_SOURCE_STRINGS) {
    if (typeof source[field] !== "string" || /^(unknown|pending)?$/i.test(source[field].trim())) throw new SourcePolicyError(`${sourceId}.${field} is invalid`);
  }
  if (!Number.isFinite(Date.parse(source.reviewedAt)) || Date.parse(source.reviewedAt) > nowMs) throw new SourcePolicyError(`${sourceId}.reviewedAt is invalid`);
  if (!Number.isInteger(source.rateLimitPerMinute) || source.rateLimitPerMinute < 1 || typeof source.costPerAttemptUsd !== "number" || !Number.isFinite(source.costPerAttemptUsd) || source.costPerAttemptUsd < 0) {
    throw new SourcePolicyError(`${sourceId} limits or cost are invalid`);
  }
  if (!Array.isArray(source.chains) || !source.chains.includes(network)) throw new SourcePolicyError(`${sourceId} has not declared chain ${network}`);
  return source;
}

function validateRequest(sourceId, network, address) {
  if (typeof sourceId !== "string" || sourceId.trim() === "") throw new SourceDataError("sourceId is invalid");
  if (!NETWORKS.has(network)) throw new SourceDataError("network is invalid");
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) throw new SourceDataError("address is invalid");
}

export function createSourceLoader({ policy, policyUrl = DEFAULT_POLICY, adapters = {}, now = Date.now, retryOptions = {} } = {}) {
  const load = async ({ sourceId, network, address, signal }) => {
    validateRequest(sourceId, network, address);
    const currentPolicy = policy ?? JSON.parse(await readFile(policyUrl, "utf8"));
    approvedSource(currentPolicy, sourceId, network, now());
    const adapter = adapters[sourceId];
    if (typeof adapter !== "function") throw new SourcePolicyError(`${sourceId} has no approved production adapter`);
    const raw = await retrySource((attemptSignal) => adapter({ network, address, signal: attemptSignal }), {
      ...retryOptions,
      signal,
      operation: "source",
    });
    if (raw?.status === 429 || raw?.status >= 500) throw new SourceDataError(`source failed with status ${raw.status}`);
    return normalize(raw, sourceId, network, now());
  };
  load.readiness = async () => {
    const currentPolicy = policy ?? JSON.parse(await readFile(policyUrl, "utf8"));
    const missing = (currentPolicy.sources ?? []).filter(({ status, id }) => status === "approved" && typeof adapters[id] !== "function").map(({ id }) => id);
    return { status: missing.length ? 503 : 200, blockers: missing.map((id) => `source-adapter-${id}`) };
  };
  return load;
}

export function assertApprovedAdapters(policy, adapters) {
  const missing = (policy?.sources ?? []).filter(({ status, id }) => status === "approved" && typeof adapters?.[id] !== "function").map(({ id }) => id);
  if (missing.length) throw new SourcePolicyError(`approved production adapter missing: ${missing.join(", ")}`);
  return adapters;
}

export async function loadAdapterRegistry({ env = process.env, policy } = {}) {
  let modules;
  try {
    modules = JSON.parse(env.CRYPTO_INTEL_SOURCE_ADAPTER_MODULES ?? "{}");
  } catch {
    throw new SourcePolicyError("CRYPTO_INTEL_SOURCE_ADAPTER_MODULES must be JSON");
  }
  if (!modules || Array.isArray(modules) || typeof modules !== "object") throw new SourcePolicyError("CRYPTO_INTEL_SOURCE_ADAPTER_MODULES must be an object");
  const adapters = {};
  const approvedIds = (policy?.sources ?? []).filter(({ id, status }) => status === "approved" && typeof id === "string" && id.trim()).map(({ id }) => id);
  for (const id of approvedIds) {
    const specifier = modules[id];
    if (specifier === undefined) continue;
    if (typeof specifier !== "string" || !specifier.startsWith("file:")) throw new SourcePolicyError(`${id} adapter module must be a file URL`);
    const loaded = await import(specifier);
    const adapter = loaded.default ?? loaded.adapter;
    if (typeof adapter !== "function") throw new SourcePolicyError(`${id} adapter module must export a function`);
    adapters[id] = adapter;
  }
  return adapters;
}
