import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createA2AState, digestPayload } from "./state.js";
import { createA2AInbox } from "./inbox.js";

const exec = promisify(execFile);
const NETWORKS = new Set(["eip155:1", "eip155:56", "eip155:8453", "eip155:42161", "eip155:196"]);
const LOCALES = new Set(["zh-CN", "en-US"]);
const FOCUS = new Set(["security", "liquidity", "concentration"]);
const MAX_CHAT_BYTES = 64 * 1024;
const MAX_SENDER_ID_BYTES = 256;
const TERMINAL = new Map([
  ["job_completed", "completed"],
  ["job_auto_completed", "completed"],
  ["job_refunded", "failed"],
  ["job_auto_refunded", "failed"],
  ["job_closed", "failed"],
  ["job_expired", "failed"],
]);

async function execute(command, args, options = {}) {
  try {
    const result = await exec(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024, ...options });
    return { status: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return { status: error.code === "ETIMEDOUT" ? 124 : (error.code || 1), stdout: error.stdout || "", stderr: error.stderr || error.message };
  }
}

function requireIdentity(env) {
  const agentId = env.CRYPTO_INTEL_AGENT_ID;
  const serviceId = env.CRYPTO_INTEL_A2A_SERVICE_ID;
  if (!agentId) throw new Error("CRYPTO_INTEL_AGENT_ID required");
  if (!serviceId) throw new Error("CRYPTO_INTEL_A2A_SERVICE_ID required");
  if (env.CRYPTO_INTEL_DRY_RUN === "1") throw new Error("dry-run forbidden for A2A provider");
  return { agentId, serviceId };
}

function isChat(envelope) {
  return envelope?.msgType === "a2a-agent-chat"
    && typeof envelope.jobId === "string"
    && typeof envelope.sender?.role === "string" && envelope.sender.role.trim().length > 0
    && typeof envelope.sender?.agentId === "string" && envelope.sender.agentId.trim().length > 0
    && Buffer.byteLength(envelope.sender.agentId) <= MAX_SENDER_ID_BYTES
    && typeof envelope.message?.content === "string"
    && Buffer.byteLength(envelope.message.content) <= MAX_CHAT_BYTES;
}

function isSystem(envelope) {
  return typeof envelope?.agentId === "string"
    && envelope.message?.source === "system"
    && typeof envelope.message.event === "string"
    && typeof envelope.message.jobId === "string";
}

function parseTaskInput(value) {
  let input = value;
  if (typeof value === "string") {
    try { input = JSON.parse(value); } catch { return null; }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (Object.keys(input).some((key) => !["network", "address", "locale", "focus"].includes(key))) return null;
  if (!NETWORKS.has(input.network) || !/^0x[0-9a-fA-F]{40}$/.test(input.address ?? "") || /^0x0{40}$/i.test(input.address)) return null;
  const locale = input.locale ?? "zh-CN";
  if (!LOCALES.has(locale) || input.focus !== undefined && !FOCUS.has(input.focus)) return null;
  return { network: input.network, address: input.address.toLowerCase(), locale, ...(input.focus ? { focus: input.focus } : {}) };
}

export function createA2AProvider({ state, env = process.env, io = fs, runner = execute, delegate } = {}) {
  if (!state) throw new TypeError("state required");
  const identity = requireIdentity(env);
  const binaries = {
    a2a: env.CRYPTO_INTEL_OKX_A2A_BIN || "okx-a2a",
    codex: env.CRYPTO_INTEL_CODEX_BIN || "codex",
    onchainos: env.CRYPTO_INTEL_ONCHAINOS_BIN || "onchainos",
  };
  const inbox = createA2AInbox({ stateDir: state.stateDir, io });
  const delegateEvent = delegate || ((event) => runner(binaries.codex, [
    "exec", "--skip-git-repo-check", "--json", JSON.stringify(event),
  ]));

  async function serviceFor(message) {
    if (message.serviceId) return message.serviceId;
    try {
      return (await state.read(message.jobId, "request")).payload.serviceId;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        return (await inbox.readRequest(message.jobId)).serviceId;
      } catch (inboxError) {
        if (inboxError.code === "ENOENT") return "";
        throw inboxError;
      }
    }
  }

  async function runChecked(command, args, timeout) {
    const result = await runner(command, args, { timeout });
    if (!result || result.status !== 0) throw new Error(result?.stderr || `${command} failed`);
    return result;
  }

  async function handleChat(envelope) {
    if (envelope.agentId !== identity.agentId) return { status: "blocked-identity" };
    if (envelope.sender.agentId === identity.agentId) return { status: "ignored-self" };
    const serviceId = await serviceFor({ ...envelope.message, jobId: envelope.jobId });
    if (!serviceId) return { status: "blocked-schema" };
    if (serviceId !== identity.serviceId) return { status: "blocked-identity" };
    const taskInput = parseTaskInput(envelope.message.content);
    if (!taskInput) return { status: "blocked-schema" };
    for (const durableState of ["accepted", "submitted", "completed", "failed", "delivery-unknown"]) {
      try { await state.read(envelope.jobId, durableState); return { status: "duplicate" }; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const request = { ...identity, ...taskInput };
    const claim = await inbox.claim(envelope.jobId, request, envelope.sender.agentId, digestPayload(taskInput));
    if (claim.status !== "claimed") return claim;
    await runChecked(binaries.a2a, [
      "xmtp-send", "--job-id", envelope.jobId,
      "--to-agent-id", envelope.sender.agentId,
      "--session-agent-id", identity.agentId,
      "--message", "已收到请求，正在等待平台接单确认后处理。", "--json",
    ], 1800);
    return { status: "acknowledged" };
  }

  async function officialNextAction(message) {
    return runChecked(binaries.onchainos, [
      "agent", "next-action", "--role", "auto", "--agentId", identity.agentId,
      "--message", JSON.stringify(message),
    ], 5000);
  }

  async function handleSystem(envelope) {
    if (envelope.agentId !== identity.agentId) return { status: "blocked-identity" };
    const message = envelope.message;
    const serviceId = await serviceFor(message);
    if (!serviceId) return { status: "blocked-schema" };
    if (serviceId !== identity.serviceId) return { status: "blocked-identity" };
    if (message.event === "job_accepted") {
      try { await state.read(message.jobId, "accepted"); return { status: "accepted" }; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      let taskInput = parseTaskInput(message.taskInput);
      if (!taskInput) {
        try {
          const saved = await inbox.readRequest(message.jobId);
          if (saved.agentId === identity.agentId && saved.serviceId === identity.serviceId) taskInput = parseTaskInput({
            network: saved.network, address: saved.address, locale: saved.locale, ...(saved.focus ? { focus: saved.focus } : {}),
          });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (!taskInput) return { status: "blocked-schema" };
      const nextAction = await officialNextAction(message);
      const event = structuredClone(envelope);
      await state.accept({
        jobId: message.jobId,
        request: { serviceId, ...taskInput, event, eventDigest: digestPayload(event) },
        accepted: {
          event: structuredClone(envelope),
          nextAction: { script: nextAction.stdout, digest: digestPayload(nextAction.stdout) },
        },
        ...identity,
      });
      await inbox.cleanup(message.jobId);
      return { status: "accepted" };
    }
    const terminal = TERMINAL.get(message.event);
    if (terminal) {
      await officialNextAction(message);
      await state.record(message.jobId, terminal, { event: structuredClone(envelope) }, identity);
      await inbox.cleanup(message.jobId);
      return { status: terminal };
    }
    const result = await delegateEvent(structuredClone(envelope));
    if (!result || result.status !== 0) throw new Error(result?.stderr || "Codex delegation failed");
    return { status: "delegated" };
  }

  return {
    handle(envelope) {
      if (isChat(envelope)) return handleChat(envelope);
      if (isSystem(envelope)) return handleSystem(envelope);
      return Promise.resolve({ status: "blocked-schema" });
    },
  };
}

async function main() {
  const envelope = JSON.parse(process.argv.at(-1));
  const state = createA2AState({ stateDir: process.env.CRYPTO_INTEL_STATE_DIR });
  console.log(JSON.stringify(await createA2AProvider({ state }).handle(envelope)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
