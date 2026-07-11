import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const openapi = JSON.parse(await readFile(resolve(workspace, "openapi/token-risk-score-v1.json"), "utf8"));
const route = openapi.paths["/v1/token-risk-score"].get;
const schemas = openapi.components.schemas;
const analysisNetworks = ["eip155:1", "eip155:56", "eip155:8453", "eip155:42161", "eip155:196"];
const highRiskResponses = ["zh-CN", "en-US"].map((locale) => ({
  schemaVersion: "1.0",
  scoreVersion: "risk-v1.0.0",
  requestId: `request-${locale}`,
  asset: { network: "eip155:1", address: "0x1111111111111111111111111111111111111111" },
  assessment: { score: 88, level: "critical", confidence: 0.85 },
  dimensions: {
    security: { score: 95, status: "fresh" },
    liquidity: { score: 75, status: "fresh" },
    concentration: { score: 80, status: "fresh" },
  },
  freshness: { observedAt: "2026-07-11T00:00:00Z", expiresAt: "2026-07-11T00:05:00Z", stale: false },
  evidence: [{ dimension: "security", source: "synthetic", summary: "high risk", observedAt: "2026-07-11T00:00:00Z" }],
  missing: [],
  conflicts: [],
  disclaimer: locale === "zh-CN" ? "仅供风险研究，不构成投资建议。" : "For risk research only; not investment advice.",
}));

function validateSuccess(body) {
  for (const field of schemas.RiskScoreResponse.required) assert.equal(Object.hasOwn(body, field), true);
  assert.equal(Number.isInteger(body.assessment.score), true);
  for (const dimension of schemas.RiskScoreResponse.properties.dimensions.required) {
    assert.equal(Object.hasOwn(body.dimensions, dimension), true);
  }
}

test("Given the paid route, when parsed, then its query boundary is exact", () => {
  assert.deepEqual(Object.keys(openapi.paths), ["/v1/token-risk-score"]);
  assert.equal(route.operationId, "getTokenRiskScore");
  const parameters = Object.fromEntries(route.parameters.map((parameter) => [parameter.name, parameter]));
  assert.deepEqual(Object.keys(parameters).sort(), ["address", "locale", "network"]);
  assert.equal(parameters.network.required, true);
  assert.deepEqual(parameters.network.schema.enum, analysisNetworks);
  assert.equal(parameters.address.required, true);
  assert.equal(parameters.address.schema.pattern, "^0x(?!0{40}$)[0-9a-fA-F]{40}$");
  assert.deepEqual(parameters.locale.schema, { type: "string", enum: ["zh-CN", "en-US"], default: "zh-CN" });
});

test("Given the service metadata, when inspected, then analysis and payment networks stay separate", () => {
  assert.deepEqual(openapi["x-analysis-networks"], analysisNetworks);
  assert.deepEqual(openapi["x-payment"], { protocol: "official-okx-x402", network: "eip155:196", passthrough402: true });
  assert.notStrictEqual(openapi["x-analysis-networks"], openapi["x-payment"].network);
});

test("Given a success response, when parsed, then the versioned risk schema is complete", () => {
  const response = route.responses["200"];
  assert.deepEqual(Object.keys(response.content), ["application/json"]);
  assert.equal(response.content["application/json"].schema.$ref, "#/components/schemas/RiskScoreResponse");
  assert.deepEqual(schemas.RiskScoreResponse.required, [
    "schemaVersion", "scoreVersion", "requestId", "asset", "assessment", "dimensions",
    "freshness", "evidence", "missing", "conflicts", "disclaimer",
  ]);
  assert.equal(schemas.RiskScoreResponse.properties.schemaVersion.const, "1.0");
  assert.equal(schemas.RiskScoreResponse.properties.scoreVersion.const, "risk-v1.0.0");
  assert.deepEqual(schemas.RiskScoreResponse.properties.dimensions.required, ["security", "liquidity", "concentration"]);
  assert.deepEqual(schemas.Assessment.properties.score, { type: "integer", minimum: 0, maximum: 100 });
  assert.equal(JSON.stringify(schemas.RiskScoreResponse).includes('"score":{"type":"null"}'), false);
});

test("Given high-risk fixtures, when validating both locales, then each matches the success contract", () => {
  for (const fixture of highRiskResponses) assert.doesNotThrow(() => validateSuccess(fixture));
  assert.match(highRiskResponses[0].disclaimer, /不构成投资建议/);
  assert.match(highRiskResponses[1].disclaimer, /not investment advice/);
});

test("Given a numeric total score, when a required dimension is absent, then the success body is rejected", () => {
  for (const dimension of schemas.RiskScoreResponse.properties.dimensions.required) {
    const malformed = structuredClone(highRiskResponses[0]);
    delete malformed.dimensions[dimension];
    assert.throws(() => validateSuccess(malformed));
  }
});

test("Given business errors, when parsed, then each maps to problem+json with score null", () => {
  for (const status of ["400", "404", "422", "503"]) {
    const response = route.responses[status];
    assert.deepEqual(Object.keys(response.content), ["application/problem+json"]);
    assert.equal(response.content["application/problem+json"].schema.$ref, "#/components/schemas/Problem");
  }
  assert.deepEqual(schemas.Problem.required, ["type", "title", "status", "code", "detail", "requestId", "retryable", "score"]);
  assert.deepEqual(schemas.Problem.properties.score, { type: "null" });
  assert.deepEqual(route.responses["400"]["x-error-codes"], ["missing_parameter"]);
  assert.deepEqual(route.responses["422"]["x-error-codes"], ["invalid_address", "unsupported_network", "invalid_locale"]);
  assert.deepEqual(route.responses["404"]["x-error-codes"], ["asset_not_found"]);
  assert.deepEqual(route.responses["503"]["x-error-codes"], ["evidence_unavailable", "upstream_unavailable"]);
});

test("Given an official payment challenge, when parsed, then 402 is passed through unchanged", () => {
  const response = route.responses["402"];
  assert.equal(response["x-okx-x402-passthrough"], true);
  assert.equal(Object.hasOwn(response, "content"), false);
  assert.deepEqual(response.headers, {
    "WWW-Authenticate": { schema: { type: "string" } },
    "PAYMENT-REQUIRED": { schema: { type: "string" } },
  });
});
