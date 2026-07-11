import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.js";
import { EvidenceUnavailableError } from "../src/scoring.js";
import { startServer } from "../src/server.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const openapi = JSON.parse(await readFile(resolve(workspace, "openapi/token-risk-score-v1.json"), "utf8"));
const contractDoc = await readFile(resolve(workspace, "docs/api-contract.md"), "utf8");
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

async function runtimeProblem(context, overrides = {}) {
  const app = createApp({
    admission: overrides.admission ?? { run: (operation) => operation({ signal: new AbortController().signal }), readiness: () => ({ status: 200 }) },
    gateReader: overrides.gateReader ?? (async () => ({ source: { status: 200 }, payment: { status: 200 }, economics: { status: 200 } })),
    readinessChecks: {
      cache: async () => ({ status: 200 }),
      journal: async () => ({ status: 200 }),
      spool: async () => ({ status: 200, blockers: [] }),
    },
    paymentMiddleware: (_request, _response, next) => next(),
    riskService: overrides.riskService ?? { assess: async () => { throw new Error("unexpected assess"); } },
    logger: () => {},
    requestId: () => "contract-request",
  });
  const server = await startServer({ app, port: 0 });
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/token-risk-score?network=eip155%3A1&address=0x1111111111111111111111111111111111111111`);
  return { response, body: await response.json() };
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
  assert.deepEqual(openapi["x-payment"], { protocol: "official-okx-x402", passthrough402: true });
  assert.equal(Object.hasOwn(openapi["x-payment"], "network"), false);
  assert.equal(openapi["x-analysis-networks"].includes("eip155:196"), true);
  assert.match(contractDoc, /`eip155:196` 仅表示可分析 X Layer 资产/);
  assert.match(contractDoc, /当前尚未批准支付网络或支付资产 tuple/);
  assert.doesNotMatch(contractDoc, /当前契约单独声明支付网络 `eip155:196`/);
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

test("Given runtime 503 paths, when called over HTTP, then every response uses a published OpenAPI code", async (context) => {
  const published = route.responses["503"]["x-error-codes"];
  const cases = [
    [{ gateReader: async () => ({ source: { status: 200 }, payment: { status: 503 }, economics: { status: 200 } }) }, "upstream_unavailable"],
    [{ admission: { run: async () => { throw Object.assign(new Error("full"), { name: "AdmissionError", status: 503 }); }, readiness: () => ({ status: 200 }) } }, "upstream_unavailable"],
    [{ riskService: { assess: async () => { throw new EvidenceUnavailableError(["liquidity"]); } } }, "evidence_unavailable"],
  ];

  for (const [options, expectedCode] of cases) {
    const { response, body } = await runtimeProblem(context, options);
    assert.equal(response.status, 503);
    assert.match(response.headers.get("content-type"), /^application\/problem\+json/);
    assert.equal(body.code, expectedCode);
    assert.equal(published.includes(body.code), true, `runtime emitted unpublished 503 code: ${body.code}`);
    for (const field of schemas.Problem.required) assert.equal(Object.hasOwn(body, field), true);
  }
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
