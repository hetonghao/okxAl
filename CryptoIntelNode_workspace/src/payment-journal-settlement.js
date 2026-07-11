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
  return stored;
}

export function isStoredSuccessResponse(response) {
  try {
    return exact(response, storedSuccessResponse(response));
  } catch {
    return false;
  }
}

export function settledSuccessfully(value) {
  return value?.success === true
    && (value.status === undefined || value.status === "success")
    && typeof value.transaction === "string" && value.transaction.length > 0
    && typeof value.network === "string" && value.network.length > 0;
}
