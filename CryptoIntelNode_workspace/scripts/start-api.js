#!/usr/bin/env node
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createA2AState } from "../a2a/state.js";
import { evaluateGates } from "./check-gates.js";
import { createAdmissionControl } from "../src/admission.js";
import { createApp } from "../src/app.js";
import { createPaymentJournal } from "../src/payment-journal.js";
import { createX402Payment } from "../src/payment.js";
import { OKXFacilitatorClient } from "../src/payment-sdk.js";
import { createRiskService } from "../src/risk-service.js";
import { startServer } from "../src/server.js";
import { assertApprovedAdapters, createSourceLoader, loadAdapterRegistry } from "../src/sources/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(name) {
  return JSON.parse(await readFile(resolve(workspace, "readiness", name), "utf8"));
}

function facilitatorConfig(env) {
  const config = {
    apiKey: env.OKX_API_KEY,
    secretKey: env.OKX_SECRET_KEY,
    passphrase: env.OKX_PASSPHRASE,
  };
  if (Object.values(config).some((value) => typeof value !== "string" || !value)) throw new Error("OKX_API_KEY, OKX_SECRET_KEY and OKX_PASSPHRASE are required");
  if (env.OKX_FACILITATOR_BASE_URL) config.baseUrl = env.OKX_FACILITATOR_BASE_URL;
  return config;
}

async function probe(instance, fallback = 200) {
  return typeof instance?.readiness === "function" ? instance.readiness() : { status: fallback };
}

export async function createApiRuntime({
  env = process.env,
  readReadiness = readJson,
  adapterRegistryFactory = loadAdapterRegistry,
  sourceLoaderFactory = createSourceLoader,
  riskServiceFactory = createRiskService,
  journalFactory = createPaymentJournal,
  facilitatorFactory = (config) => new OKXFacilitatorClient(config),
  paymentFactory = createX402Payment,
  stateFactory = createA2AState,
  admissionFactory = createAdmissionControl,
  appFactory = createApp,
} = {}) {
  const stateDir = env.CRYPTO_INTEL_STATE_DIR;
  if (!stateDir) throw new Error("CRYPTO_INTEL_STATE_DIR is required");
  const [dataSources, payment, economics] = await Promise.all([
    readReadiness("data-sources.json"), readReadiness("payment.json"), readReadiness("unit-economics.json"),
  ]);
  const gates = evaluateGates({ dataSources, payment, economics });
  const state = stateFactory({ stateDir });
  const admission = admissionFactory();
  const layerBlocked = (prefixes) => gates.reasons.some((reason) => prefixes.some((prefix) => reason.startsWith(prefix)));

  let riskService;
  let paymentMiddleware;
  let journal;
  let loadSource;
  if (gates.reasons.length) {
    const blocked = () => { throw new Error("production dependencies are blocked-external"); };
    riskService = { assess: blocked };
    paymentMiddleware = (_request, _response, next) => next(new Error("payment is blocked-external"));
  } else {
    const adapters = assertApprovedAdapters(dataSources, await adapterRegistryFactory({ env, policy: dataSources }));
    loadSource = sourceLoaderFactory({ policy: dataSources, adapters });
    riskService = riskServiceFactory({
      sources: dataSources.sources.map((source) => ({ id: source.id, policyVersion: dataSources.policyVersion, policyExpiresAt: source.expiresAt })),
      loadSource,
    });
    journal = journalFactory({ stateDir });
    const facilitatorClient = facilitatorFactory(facilitatorConfig(env));
    const timeoutMs = Number(env.CRYPTO_INTEL_PAYMENT_TIMEOUT_MS ?? 10_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("CRYPTO_INTEL_PAYMENT_TIMEOUT_MS must be a positive integer");
    const startupTimeoutMs = Number(env.CRYPTO_INTEL_PAYMENT_STARTUP_TIMEOUT_MS ?? 10_000);
    if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs <= 0) throw new Error("CRYPTO_INTEL_PAYMENT_STARTUP_TIMEOUT_MS must be a positive integer");
    paymentMiddleware = await paymentFactory({ config: payment, facilitatorClient, journal, timeoutMs, startupTimeoutMs });
  }

  const gateReader = async () => gates.reasons.length ? {
    source: { status: Array.isArray(dataSources.sources) && dataSources.sources.length > 0
      && dataSources.sources.every(({ status }) => status === "approved")
      && !layerBlocked(["sources[", "dataSources"]) ? 200 : 503 },
    payment: { status: payment.status === "approved" && !layerBlocked(["payment."]) ? 200 : 503 },
    economics: { status: economics.status === "approved" && !layerBlocked(["economics.", "net contribution"]) ? 200 : 503 },
  } : {
    source: await probe(loadSource),
    payment: await probe(paymentMiddleware),
    economics: { status: 200 },
  };
  const app = appFactory({
    riskService,
    paymentMiddleware,
    gateReader,
    admission,
    readinessChecks: {
      cache: async () => ({ status: riskService ? 200 : 503 }),
      journal: () => probe(journal, gates.reasons.length ? 200 : 503),
      spool: () => state.readiness(),
    },
    logger: (entry) => console.log(JSON.stringify(entry)),
  });
  return { app, gates, state, riskService, paymentMiddleware, journal, loadSource };
}

export async function main({ env = process.env, start = startServer, ...options } = {}) {
  const host = env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("HOST must be 127.0.0.1");
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT is invalid");
  const stateDir = env.CRYPTO_INTEL_STATE_DIR;
  if (!stateDir) throw new Error("CRYPTO_INTEL_STATE_DIR is required");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await access(stateDir, constants.W_OK);
  const runtime = await createApiRuntime({ env, ...options });
  const server = await start({ app: runtime.app, host, port });
  console.log(JSON.stringify({ status: "listening", host, port: server.address().port, gates: runtime.gates.status }));

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close((error) => {
      if (error) console.error(JSON.stringify({ status: "close-failed", error: error.message }));
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  return { ...runtime, server };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  console.error(JSON.stringify({ status: "blocked", reasons: [error.message] }));
  process.exitCode = 2;
});
