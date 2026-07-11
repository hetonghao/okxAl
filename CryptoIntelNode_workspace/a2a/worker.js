import { join } from "node:path";

import { generateRiskReport } from "../src/report.js";
import { digestPayload } from "./state.js";

const JOB_ID = /^0x[0-9a-f]{64}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]+$/;

async function optionalRead(state, jobId, name) {
  try { return await state.read(jobId, name); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function parseDeliver(script, jobId, agentId) {
  if (typeof script !== "string" || /[;&|`$<>\\\n\r'\"]/.test(script)) throw new Error("invalid next-action deliver command");
  const tokens = script.trim().split(/\s+/);
  if (
    tokens.length !== 6 || tokens[0] !== "onchainos" || tokens[1] !== "agent" || tokens[2] !== "deliver"
    || tokens[3] !== jobId || !JOB_ID.test(tokens[3]) || tokens[4] !== "--agent-id"
    || tokens[5] !== agentId || !AGENT_ID.test(agentId)
  ) throw new Error("invalid next-action deliver command");
  return { command: tokens[0], args: tokens.slice(1) };
}

function providerStatus(result) {
  if (!result || result.status !== 0 || typeof result.stdout !== "string") return null;
  try {
    const value = JSON.parse(result.stdout);
    const status = value?.status ?? value?.data?.status;
    if (typeof status === "number") return { 1: "accepted", 2: "submitted", 6: "completed" }[status] ?? null;
    if (typeof status !== "string") return null;
    return status.toLowerCase() === "complete" ? "completed" : status.toLowerCase();
  } catch {
    return null;
  }
}

function assessmentInput(result, request) {
  if (result?.assessment) return { asset: result.asset ?? request, assessment: result.assessment };
  return { asset: request, assessment: result };
}

export function createA2AWorker({
  state,
  identity,
  assess,
  report = generateRiskReport,
  runner,
  statusRunner,
  workerId = "crypto-intel-worker",
} = {}) {
  if (!state || !identity?.agentId || !identity?.serviceId) throw new TypeError("state and identity are required");

  async function reconcile(jobId) {
    let result;
    try {
      result = typeof statusRunner === "function"
        ? await statusRunner("onchainos", ["agent", "status", jobId, "--agent-id", identity.agentId], { timeout: 5_000 })
        : null;
    } catch {
      result = null;
    }
    const status = providerStatus(result);
    if (status === "submitted" || status === "completed") {
      await state.record(jobId, status, { reconciled: true, providerStatus: status }, identity);
      return { jobId, status };
    }
    await state.record(jobId, "delivery-unknown", { reason: "ambiguous-delivery", providerStatus: status }, identity);
    return { jobId, status: "delivery-unknown" };
  }

  async function runOnce() {
    const claimed = await state.claimNext(workerId);
    if (!claimed) return null;
    const { jobId } = claimed;
    const accepted = await state.read(jobId, "accepted");
    if (accepted.agentId !== identity.agentId || accepted.serviceId !== identity.serviceId) throw new Error("accepted identity conflict");
    const script = accepted.payload?.nextAction?.script;
    if (accepted.payload?.nextAction?.digest && accepted.payload.nextAction.digest !== digestPayload(script)) throw new Error("invalid next-action digest");
    const action = parseDeliver(script, jobId, identity.agentId);

    if (await optionalRead(state, jobId, "delivery-attempt")) return reconcile(jobId);
    if (typeof assess !== "function" || typeof runner !== "function") throw new TypeError("assess and runner are required");

    const request = (await state.read(jobId, "request")).payload;
    const result = assessmentInput(await assess(structuredClone(request)), request);
    const markdown = report({
      network: result.asset.network,
      address: result.asset.address,
      locale: request.locale ?? "zh-CN",
      focus: request.focus,
      assessment: result.assessment,
    });
    const prepared = await state.writeDeliverable(jobId, markdown, identity);
    const deliverable = join(state.root, "jobs", jobId, "deliverable.md");
    await state.record(jobId, "delivery-attempt", {
      command: "onchainos agent deliver",
      deliverableDigest: prepared.payload.markdownDigest,
    }, identity);

    let delivered;
    try {
      delivered = await runner(action.command, [...action.args, "--file", deliverable], { timeout: 30_000 });
    } catch (error) {
      await state.record(jobId, "failed", { reason: "deliver-failed", error: error?.code ?? "runner-error" }, identity);
      throw error;
    }
    if (providerStatus(delivered) !== "submitted") {
      await state.record(jobId, "failed", { reason: "deliver-failed", exitStatus: delivered?.status ?? null }, identity);
      throw new Error(delivered?.stderr || "deliver output was not submitted");
    }
    await state.record(jobId, "submitted", { deliveryStatus: "submitted" }, identity);
    return { jobId, status: "submitted" };
  }

  return { runOnce };
}
