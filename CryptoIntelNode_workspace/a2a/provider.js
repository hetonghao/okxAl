import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createA2AState, digestPayload } from "./state.js";
import { atomicPublish, recoverAtomicPublishes } from "./state-io.js";

const exec = promisify(execFile);
const JOB_ID = /^0x[0-9a-f]{64}$/;
const NETWORKS = new Set(["eip155:1", "eip155:56", "eip155:8453", "eip155:42161", "eip155:196"]);
const LOCALES = new Set(["zh-CN", "en-US"]);
const FOCUS = new Set(["security", "liquidity", "concentration"]);
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
    && typeof envelope.message?.content === "string";
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
  const inbox = join(state.stateDir, "a2a-inbox");
  let initialized = false;
  const delegateEvent = delegate || ((event) => runner(binaries.codex, [
    "exec", "--skip-git-repo-check", "--json", JSON.stringify(event),
  ]));

  function inboxPath(jobId, name) {
    if (!JOB_ID.test(jobId)) throw new TypeError("jobId must be lowercase 32-byte hex");
    return join(inbox, jobId, name);
  }

  async function initializeInbox() {
    if (initialized) return;
    await io.mkdir(inbox, { recursive: true, mode: 0o700 });
    await recoverAtomicPublishes(inbox, JOB_ID, io);
    initialized = true;
  }

  async function publish(jobId, name, value) {
    await initializeInbox();
    const directory = inboxPath(jobId, "");
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    return atomicPublish(inboxPath(jobId, name), `${JSON.stringify(value)}\n`, io);
  }

  async function readInbox(jobId, name) {
    await initializeInbox();
    return JSON.parse(await io.readFile(inboxPath(jobId, name), "utf8"));
  }

  async function serviceFor(message) {
    if (message.serviceId) return message.serviceId;
    try {
      return (await state.read(message.jobId, "request")).payload.serviceId;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        return (await readInbox(message.jobId, "request.json")).serviceId;
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
    const contentKey = `digest:${digestPayload(`${envelope.jobId}|${envelope.sender.agentId}|${envelope.message.content}`)}`;
    const messageKey = `id:${envelope.message.messageId || contentKey}`;
    if (!await publish(envelope.jobId, "request.json", { ...identity, ...taskInput })) {
      const request = await readInbox(envelope.jobId, "request.json");
      if (request.agentId !== identity.agentId || request.serviceId !== identity.serviceId || digestPayload(taskInput) !== digestPayload({
        network: request.network, address: request.address, locale: request.locale, ...(request.focus ? { focus: request.focus } : {}),
      })) return { status: "blocked-identity" };
    }
    if (!await publish(envelope.jobId, `${digestPayload(messageKey)}.json`, { kind: "message" })) {
      return { status: "duplicate" };
    }
    if (contentKey !== messageKey && !await publish(envelope.jobId, `${digestPayload(contentKey)}.json`, { kind: "content" })) {
      return { status: "duplicate" };
    }
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
      let taskInput = parseTaskInput(message.taskInput);
      if (!taskInput) {
        try {
          const saved = await readInbox(message.jobId, "request.json");
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
      return { status: "accepted" };
    }
    const terminal = TERMINAL.get(message.event);
    if (terminal) {
      await officialNextAction(message);
      await state.record(message.jobId, terminal, { event: structuredClone(envelope) }, identity);
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
