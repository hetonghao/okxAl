#!/usr/bin/env node
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createA2AState } from "../a2a/state.js";
import { evaluateGates } from "./check-gates.js";
import { createAdmissionControl } from "../src/admission.js";
import { createApp } from "../src/app.js";
import { startServer } from "../src/server.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(name) {
  return JSON.parse(await readFile(resolve(workspace, "readiness", name), "utf8"));
}

async function main() {
  const host = process.env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("HOST must be 127.0.0.1");
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT is invalid");
  const stateDir = process.env.CRYPTO_INTEL_STATE_DIR;
  if (!stateDir) throw new Error("CRYPTO_INTEL_STATE_DIR is required");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await access(stateDir, constants.W_OK);

  const [dataSources, payment, economics] = await Promise.all([
    readJson("data-sources.json"), readJson("payment.json"), readJson("unit-economics.json"),
  ]);
  const gates = evaluateGates({ dataSources, payment, economics });
  const layerBlocked = (prefixes) => gates.reasons.some((reason) => prefixes.some((prefix) => reason.startsWith(prefix)));
  const gateReader = async () => ({
    source: { status: Array.isArray(dataSources.sources) && dataSources.sources.length > 0
      && dataSources.sources.every(({ status }) => status === "approved")
      && !layerBlocked(["sources[", "dataSources"]) ? 200 : 503 },
    payment: { status: payment.status === "approved" && !layerBlocked(["payment."]) ? 200 : 503 },
    economics: { status: economics.status === "approved"
      && !layerBlocked(["economics.", "net contribution"]) ? 200 : 503 },
  });
  const state = createA2AState({ stateDir });
  const admission = createAdmissionControl();

  // These dependencies are unreachable while the real approval gates are blocked.
  // They fail closed so this entry point cannot accidentally serve paid synthetic data.
  const blocked = () => { throw new Error("production dependencies are blocked-external"); };
  const app = createApp({
    riskService: { assess: blocked },
    paymentMiddleware: (_request, _response, next) => next(new Error("payment is blocked-external")),
    gateReader,
    admission,
    readinessChecks: {
      cache: async () => ({ status: 200 }),
      journal: async () => ({ status: 200 }),
      spool: () => state.readiness(),
    },
    logger: (entry) => console.log(JSON.stringify(entry)),
  });
  const server = await startServer({ app, host, port });
  console.log(JSON.stringify({ status: "listening", host, port: server.address().port, gates: gates.status }));

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
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "blocked", reasons: [error.message] }));
  process.exitCode = 2;
});
