import { SCORE_VERSION } from "./scoring.js";

const NETWORKS = new Set(["eip155:1", "eip155:56", "eip155:8453", "eip155:42161", "eip155:196"]);
const DIMENSIONS = new Set(["security", "liquidity", "concentration"]);
const DIMENSION_STATUSES = new Set(["fresh", "stale", "conflicted"]);
const LEVELS = new Set(["low", "medium", "high", "critical"]);
const DISCLAIMERS = new Set([
  "For risk research only; not investment advice.",
  "仅供风险研究，不构成投资建议。",
]);
const ADDRESS = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;

function record(value, name = "value") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function own(value, key, type) {
  const descriptor = Object.getOwnPropertyDescriptor(record(value), key);
  if (!descriptor || !("value" in descriptor) || (type && typeof descriptor.value !== type)) {
    throw new TypeError(`${key} is invalid`);
  }
  return descriptor.value;
}

function finite(value, key) {
  const number = own(value, key, "number");
  if (!Number.isFinite(number)) throw new TypeError(`${key} is invalid`);
  return number;
}

function semantic(condition, key) {
  if (!condition) throw new TypeError(`${key} is invalid`);
}

function timestamp(value, key) {
  const milliseconds = Date.parse(value);
  semantic(Number.isFinite(milliseconds), key);
  return milliseconds;
}

function validateStoredBody(body) {
  semantic(body.schemaVersion === "1.0", "schemaVersion");
  semantic(body.scoreVersion === SCORE_VERSION, "scoreVersion");
  semantic(body.requestId.trim().length > 0, "requestId");
  semantic(NETWORKS.has(body.asset.network), "network");
  semantic(ADDRESS.test(body.asset.address), "address");
  semantic(body.assessment.score >= 0 && body.assessment.score <= 100, "assessment.score");
  semantic(LEVELS.has(body.assessment.level), "assessment.level");
  semantic(body.assessment.confidence >= 0 && body.assessment.confidence <= 1, "assessment.confidence");
  for (const dimension of Object.values(body.dimensions)) {
    semantic(dimension.score >= 0 && dimension.score <= 100, "dimension.score");
    semantic(DIMENSION_STATUSES.has(dimension.status), "dimension.status");
  }
  const observedAt = timestamp(body.freshness.observedAt, "freshness.observedAt");
  const expiresAt = timestamp(body.freshness.expiresAt, "freshness.expiresAt");
  semantic(observedAt < expiresAt, "freshness");
  for (const evidence of body.evidence) {
    semantic(DIMENSIONS.has(evidence.dimension), "evidence.dimension");
    semantic(evidence.source.trim().length > 0, "evidence.source");
    semantic(evidence.summary.trim().length > 0, "evidence.summary");
    const evidenceAt = timestamp(evidence.observedAt, "evidence.observedAt");
    semantic(evidenceAt >= observedAt && evidenceAt <= expiresAt, "evidence.observedAt");
  }
  semantic(DISCLAIMERS.has(body.disclaimer), "disclaimer");
}

function list(value, key, map) {
  const values = own(value, key);
  if (!Array.isArray(values)) throw new TypeError(`${key} is invalid`);
  return Array.from({ length: values.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor || !("value" in descriptor)) throw new TypeError(`${key} is invalid`);
    return map(descriptor.value);
  });
}

function exact(value, expected) {
  if (!expected || typeof expected !== "object") return Object.is(value, expected);
  if (!value || typeof value !== "object") return false;
  if (Object.keys(value).length !== Object.keys(expected).length) return false;
  return Object.keys(expected).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
    const actual = descriptor.value;
    const wanted = expected[key];
    if (Array.isArray(wanted)) return Array.isArray(actual) && actual.length === wanted.length
      && wanted.every((item, index) => {
        const itemDescriptor = Object.getOwnPropertyDescriptor(actual, String(index));
        return itemDescriptor && "value" in itemDescriptor && exact(itemDescriptor.value, item);
      });
    if (wanted && typeof wanted === "object") return actual && typeof actual === "object" && exact(actual, wanted);
    return Object.is(actual, wanted);
  });
}

export function storedSuccessResponse(response) {
  const status = own(response, "status", "number");
  if (!Number.isInteger(status) || status < 200 || status >= 300) throw new TypeError("status is invalid");
  const body = record(own(response, "body"), "body");
  const dimension = (value) => ({ score: finite(value, "score"), status: own(value, "status", "string") });
  const stored = {
    status,
    body: {
      schemaVersion: own(body, "schemaVersion", "string"),
      scoreVersion: own(body, "scoreVersion", "string"),
      requestId: own(body, "requestId", "string"),
      asset: {
        network: own(own(body, "asset"), "network", "string"),
        address: own(own(body, "asset"), "address", "string"),
      },
      assessment: {
        score: finite(own(body, "assessment"), "score"),
        level: own(own(body, "assessment"), "level", "string"),
        confidence: finite(own(body, "assessment"), "confidence"),
      },
      dimensions: {
        security: dimension(own(own(body, "dimensions"), "security")),
        liquidity: dimension(own(own(body, "dimensions"), "liquidity")),
        concentration: dimension(own(own(body, "dimensions"), "concentration")),
      },
      freshness: {
        observedAt: own(own(body, "freshness"), "observedAt", "string"),
        expiresAt: own(own(body, "freshness"), "expiresAt", "string"),
        stale: own(own(body, "freshness"), "stale", "boolean"),
      },
      evidence: list(body, "evidence", (value) => ({
        dimension: own(value, "dimension", "string"),
        source: own(value, "source", "string"),
        summary: own(value, "summary", "string"),
        observedAt: own(value, "observedAt", "string"),
      })),
      missing: list(body, "missing", (value) => {
        if (typeof value !== "string") throw new TypeError("missing is invalid");
        return value;
      }),
      conflicts: list(body, "conflicts", (value) => {
        if (typeof value !== "string") throw new TypeError("conflicts is invalid");
        return value;
      }),
      disclaimer: own(body, "disclaimer", "string"),
    },
  };
  validateStoredBody(stored.body);
  return stored;
}

export function isStoredSuccessResponse(response) {
  try {
    return exact(response, storedSuccessResponse(response));
  } catch {
    return false;
  }
}

function sameAddress(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function requirementsMatch(actual, approved) {
  try {
    return own(actual, "scheme", "string") === own(approved, "scheme", "string")
      && own(actual, "network", "string") === own(approved, "network", "string")
      && sameAddress(own(actual, "asset", "string"), own(approved, "asset", "string"))
      && own(actual, "amount", "string") === own(approved, "amount", "string")
      && sameAddress(own(actual, "payTo", "string"), own(approved, "payTo", "string"))
      && own(own(actual, "extra"), "decimals", "number") === own(own(approved, "extra"), "decimals", "number")
      && own(own(actual, "extra"), "symbol", "string") === own(own(approved, "extra"), "symbol", "string");
  } catch {
    return false;
  }
}

export function settlementContextMatches(expected) {
  try {
    return own(expected, "network", "string") === own(own(expected, "approvedRequirements"), "network", "string")
      && requirementsMatch(own(expected, "requirements"), own(expected, "approvedRequirements"));
  } catch {
    return false;
  }
}

export function settledSuccessfully(value, expected) {
  try {
    const status = Object.getOwnPropertyDescriptor(record(value), "status");
    return own(value, "success", "boolean") === true
      && (!status || ("value" in status && status.value === "success"))
      && /^0x[0-9a-fA-F]{64}$/.test(own(value, "transaction", "string"))
      && own(value, "network", "string") === own(expected, "network", "string")
      && settlementContextMatches(expected);
  } catch {
    return false;
  }
}
