import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createApiRuntime } from "../scripts/start-api.js";
import { runA2AWorker } from "../scripts/run-a2a-worker.js";
import { loadAdapterRegistry } from "../src/sources/index.js";

function approvedReadiness() {
  const approval = {
    status: "approved",
    approvedBy: "fixture@example.invalid",
    approvedAt: "2026-07-10T00:00:00Z",
    expiresAt: "2099-08-10T00:00:00Z",
  };
  return {
    "data-sources.json": {
      policyVersion: "fixture-v1",
      sources: [{
        id: "synthetic", endpoint: "https://source.example.invalid", plan: "server",
        docsUrl: "https://docs.example.invalid", termsUrl: "https://terms.example.invalid",
        reviewedAt: "2026-07-10T00:00:00Z", attribution: "required",
        commercialServerUse: "yes", derivativePaidOutput: "yes", cache: "yes",
        realFixtureRetention: "yes", rateLimitPerMinute: 1, costPerAttemptUsd: 0.001,
        chains: ["eip155:1"], ...approval,
      }],
    },
    "payment.json": {
      listingFee: "0.02", runtimePrice: "$0.02", settlementCostUsd: 0.001,
      tuple: { network: "eip155:1", contract: `0x${"1".repeat(40)}`, decimals: 6, amountAtomic: "20000", payTo: `0x${"2".repeat(40)}`, symbol: "SYNTH" },
      a2aQuote: { mode: "separate" }, ...approval,
    },
    "unit-economics.json": {
      maxSourceAttempts: 2, marginalInfraCostUsd: 0.001, failureReserveUsd: 0.001,
      minimumFailureReserveRate: 0.05, minimumNetContributionUsd: 0.005,
      cacheHitRateAssumption: 0, ...approval,
    },
  };
}

const readApproved = (values) => async (name) => structuredClone(values[name]);

test("adapter registry imports only policy-approved named sources", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crypto-intel-adapters-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const approvedModule = join(directory, "approved.mjs");
  const blockedModule = join(directory, "blocked.mjs");
  const extraModule = join(directory, "extra.mjs");
  const unnamedModule = join(directory, "unnamed.mjs");
  const blockedMarker = join(directory, "blocked-imported");
  const extraMarker = join(directory, "extra-imported");
  const unnamedMarker = join(directory, "unnamed-imported");
  await writeFile(approvedModule, "export default async function adapter() {}\n");
  await writeFile(blockedModule, `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(blockedMarker)}, "bad"); export default async function adapter() {}\n`);
  await writeFile(extraModule, `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(extraMarker)}, "bad"); export default async function adapter() {}\n`);
  await writeFile(unnamedModule, `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(unnamedMarker)}, "bad"); export default async function adapter() {}\n`);
  const registry = await loadAdapterRegistry({
    env: { CRYPTO_INTEL_SOURCE_ADAPTER_MODULES: JSON.stringify({
      synthetic: pathToFileURL(approvedModule).href,
      blocked: pathToFileURL(blockedModule).href,
      extra: pathToFileURL(extraModule).href,
      undefined: pathToFileURL(unnamedModule).href,
    }) },
    policy: { sources: [{ id: "synthetic", status: "approved" }, { id: "blocked", status: "pending" }, { status: "approved" }] },
  });

  assert.deepEqual(Object.keys(registry), ["synthetic"]);
  await assert.rejects(access(blockedMarker), { code: "ENOENT" });
  await assert.rejects(access(extraMarker), { code: "ENOENT" });
  await assert.rejects(access(unnamedMarker), { code: "ENOENT" });
});

test("approved API wiring probes the real payment journal instance", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "crypto-intel-journal-ready-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let appOptions;
  const runtime = await createApiRuntime({
    env: {
      CRYPTO_INTEL_STATE_DIR: stateDir,
      OKX_API_KEY: "fixture-key", OKX_SECRET_KEY: "fixture-secret", OKX_PASSPHRASE: "fixture-passphrase",
    },
    readReadiness: readApproved(approvedReadiness()),
    adapterRegistryFactory: async () => ({ synthetic: async () => null }),
    sourceLoaderFactory: () => Object.assign(async () => null, { readiness: async () => ({ status: 200 }) }),
    riskServiceFactory: () => ({ assess: async () => null }),
    facilitatorFactory: () => ({}),
    paymentFactory: async ({ journal }) => Object.assign((_request, _response, next) => next(), { journal, readiness: async () => ({ status: 200 }) }),
    stateFactory: () => ({ readiness: async () => ({ status: 200 }) }),
    admissionFactory: () => ({ readiness: async () => ({ status: 200 }), run: (operation) => operation() }),
    appFactory(options) { appOptions = options; return {}; },
  });

  assert.equal(runtime.paymentMiddleware.journal, runtime.journal);
  assert.deepEqual(await appOptions.readinessChecks.journal(), { status: 200, blockers: [] });
  await mkdir(join(stateDir, "http", "results", "incomplete"));
  assert.deepEqual(await appOptions.readinessChecks.journal(), { status: 503, blockers: ["journal-unavailable"] });
});

test("approved API wiring uses real injected source, risk, journal and x402 instances in readiness", async () => {
  const readiness = approvedReadiness();
  const adapter = async () => null;
  const loadSource = Object.assign(async () => null, { readiness: async () => ({ status: 200, instance: "source" }) });
  const riskService = { assess: async () => null, readiness: () => loadSource.readiness() };
  const journal = { readiness: async () => ({ status: 200, instance: "journal" }) };
  const facilitator = { instance: "facilitator" };
  const paymentMiddleware = Object.assign((_request, _response, next) => next(), { readiness: async () => ({ status: 200, instance: "payment" }) });
  const observed = {};

  const runtime = await createApiRuntime({
    env: {
      CRYPTO_INTEL_STATE_DIR: "/tmp/crypto-intel-wiring-api",
      OKX_API_KEY: "fixture-key", OKX_SECRET_KEY: "fixture-secret", OKX_PASSPHRASE: "fixture-passphrase",
    },
    readReadiness: readApproved(readiness),
    adapterRegistryFactory: async () => ({ synthetic: adapter }),
    sourceLoaderFactory(options) { observed.source = options; return loadSource; },
    riskServiceFactory(options) { observed.risk = options; return riskService; },
    journalFactory(options) { observed.journal = options; return journal; },
    facilitatorFactory(config) { observed.facilitator = config; return facilitator; },
    paymentFactory(options) { observed.payment = options; return paymentMiddleware; },
    stateFactory: () => ({ readiness: async () => ({ status: 200 }) }),
    admissionFactory: () => ({ readiness: async () => ({ status: 200 }), run: (operation) => operation() }),
    appFactory(options) { observed.app = options; return { instance: "app" }; },
  });

  assert.equal(runtime.app.instance, "app");
  assert.equal(observed.source.adapters.synthetic, adapter);
  assert.equal(observed.risk.loadSource, loadSource);
  assert.deepEqual(observed.journal, { stateDir: "/tmp/crypto-intel-wiring-api" });
  assert.equal(observed.payment.journal, journal);
  assert.equal(observed.payment.facilitatorClient, facilitator);
  assert.equal(observed.app.riskService, riskService);
  assert.equal(observed.app.paymentMiddleware, paymentMiddleware);
  assert.deepEqual(await observed.app.gateReader(), {
    source: { status: 200, instance: "source" },
    payment: { status: 200, instance: "payment" },
    economics: { status: 200 },
  });
  assert.deepEqual(await observed.app.readinessChecks.journal(), { status: 200, instance: "journal" });
});

test("approved API and A2A wiring fail closed when a named production adapter is absent", async () => {
  const readiness = approvedReadiness();
  const common = {
    env: {
      CRYPTO_INTEL_STATE_DIR: "/tmp/crypto-intel-wiring-missing",
      CRYPTO_INTEL_AGENT_ID: "agent-fixture",
      CRYPTO_INTEL_A2A_SERVICE_ID: "service-fixture",
      OKX_API_KEY: "fixture-key", OKX_SECRET_KEY: "fixture-secret", OKX_PASSPHRASE: "fixture-passphrase",
    },
    readReadiness: readApproved(readiness),
    adapterRegistryFactory: async () => ({}),
  };

  await assert.rejects(createApiRuntime(common), /approved production adapter.*synthetic/i);
  const worker = await runA2AWorker(common);
  assert.equal(worker.status, "blocked");
  assert.match(worker.reasons.join("\n"), /approved production adapter.*synthetic/i);
});

test("approved A2A wiring passes the named adapter registry to the production loader", async () => {
  const readiness = approvedReadiness();
  const adapter = async () => null;
  const loadSource = async () => null;
  const observed = { runs: 0 };

  const result = await runA2AWorker({
    env: {
      CRYPTO_INTEL_STATE_DIR: "/tmp/crypto-intel-wiring-worker",
      CRYPTO_INTEL_AGENT_ID: "agent-fixture",
      CRYPTO_INTEL_A2A_SERVICE_ID: "service-fixture",
    },
    readReadiness: readApproved(readiness),
    adapterRegistryFactory: async () => ({ synthetic: adapter }),
    sourceLoaderFactory(options) { observed.source = options; return loadSource; },
    riskServiceFactory(options) { observed.risk = options; observed.riskService = { assess: async () => null }; return observed.riskService; },
    createState: () => ({ instance: "state" }),
    createWorker(options) {
      observed.worker = options;
      return { async runOnce() { observed.runs += 1; return null; } };
    },
    runner: async () => ({ status: 0, stdout: "{}", stderr: "" }),
  });

  assert.equal(result.status, "ok");
  assert.equal(observed.source.adapters.synthetic, adapter);
  assert.equal(observed.risk.loadSource, loadSource);
  assert.equal(observed.worker.assess, observed.riskService.assess);
  assert.equal(observed.runs, 1);
});
