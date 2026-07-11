#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createA2AState } from "../a2a/state.js";
import { createA2AWorker } from "../a2a/worker.js";
import { createRiskService } from "../src/risk-service.js";
import { createSourceLoader } from "../src/sources/index.js";
import { evaluateGates } from "./check-gates.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);

async function readJson(name) {
  return JSON.parse(await readFile(resolve(workspace, "readiness", name), "utf8"));
}

function cliRunner(env) {
  return async (command, args, options) => {
    if (env.NO_NETWORK === "1") throw new Error("CLI disabled by NO_NETWORK");
    const result = await execute(command, args, options);
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  };
}

export async function runA2AWorker({
  env = process.env,
  readReadiness = readJson,
  createState = createA2AState,
  createWorker = createA2AWorker,
  sourceLoaderFactory = createSourceLoader,
  riskServiceFactory = createRiskService,
  runner,
} = {}) {
  const stateDir = env.CRYPTO_INTEL_STATE_DIR;
  const agentId = env.CRYPTO_INTEL_AGENT_ID;
  const serviceId = env.CRYPTO_INTEL_A2A_SERVICE_ID;
  const [dataSources, payment, economics] = await Promise.all([
    readReadiness("data-sources.json"),
    readReadiness("payment.json"),
    readReadiness("unit-economics.json"),
  ]);
  const gates = evaluateGates({ dataSources, payment, economics });
  const reasons = [...gates.reasons];
  if (!stateDir || !agentId || !serviceId) {
    reasons.unshift("CRYPTO_INTEL_STATE_DIR, CRYPTO_INTEL_AGENT_ID and CRYPTO_INTEL_A2A_SERVICE_ID are required");
  }
  if (reasons.length) return { status: "blocked", reasons };

  const loadSource = sourceLoaderFactory({ policy: dataSources });
  const riskService = riskServiceFactory({
    sources: dataSources.sources.map((source) => ({
      id: source.id,
      policyVersion: dataSources.policyVersion,
      policyExpiresAt: source.expiresAt,
    })),
    loadSource,
  });
  const commandRunner = runner ?? cliRunner(env);
  const worker = createWorker({
    state: createState({ stateDir }),
    identity: { agentId, serviceId },
    assess: riskService.assess,
    runner: commandRunner,
    statusRunner: commandRunner,
  });
  return { status: "ok", result: await worker.runOnce() };
}

export async function main(options) {
  try {
    const result = await runA2AWorker(options);
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "blocked" ? 2 : 0;
    return result;
  } catch (error) {
    const result = { status: "blocked", reasons: [error.message] };
    console.log(JSON.stringify(result));
    process.exitCode = 2;
    return result;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
