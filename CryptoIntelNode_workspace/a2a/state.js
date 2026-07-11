import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { atomicPublish, directorySize, recoverAtomicPublishes, syncDirectory } from "./state-io.js";
import { createStateQueue } from "./state-queue.js";

const SCHEMA_VERSION = 1;
const JOB_ID = /^0x[0-9a-f]{64}$/;
const MESSAGE_STATE = /^message-[0-9a-f]{64}$/;
const JSON_STATES = new Set([
  "request", "accepted", "working", "deliverable", "delivery-attempt", "submitted", "completed",
  "failed", "delivery-unknown",
]);
const TERMINAL_STATES = ["submitted", "completed", "failed", "delivery-unknown"];
const MAX_SPOOL_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const STALE_WORKING_MS = 15 * 60 * 1000;
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_RECORDS = new Set(["submitted", "completed", "failed", "delivery-unknown"]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestPayload(payload) {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function validIdentity(identity) {
  if (!identity || typeof identity.agentId !== "string" || !identity.agentId) throw new TypeError("agentId required");
  if (typeof identity.serviceId !== "string" || !identity.serviceId) throw new TypeError("serviceId required");
}

function validJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new TypeError("jobId must be lowercase 32-byte hex");
  return jobId;
}

function validState(state) {
  if (!JSON_STATES.has(state) && !MESSAGE_STATE.test(state)) throw new TypeError("unknown state");
  return state;
}

export function createA2AState({ stateDir, now = Date.now, io = fs } = {}) {
  if (typeof stateDir !== "string" || !stateDir) throw new TypeError("stateDir required");
  const root = join(stateDir, "a2a");
  const jobs = join(root, "jobs");
  let recovered = false;
  let queue;

  async function initialize() {
    await io.mkdir(jobs, { recursive: true, mode: 0o700 });
    if (recovered) return;
    await recoverAtomicPublishes(jobs, JOB_ID, io);
    recovered = true;
  }

  function jobPath(jobId) {
    return join(jobs, validJobId(jobId));
  }

  async function read(jobId, state) {
    const path = join(jobPath(jobId), `${validState(state)}.json`);
    if ((await io.lstat(path)).isSymbolicLink()) throw new Error("symlink state");
    const value = JSON.parse(await io.readFile(path, "utf8"));
    if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("unknown schema");
    validIdentity(value);
    if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) throw new Error("invalid timestamp");
    if (value.digest !== digestPayload(value.payload)) throw new Error("digest mismatch");
    return value;
  }

  async function record(jobId, state, payload, identity) {
    validIdentity(identity);
    validState(state);
    await initialize();
    const directory = jobPath(jobId);
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    if (state !== "request") {
      const anchor = await read(jobId, "request");
      if (anchor.agentId !== identity.agentId || anchor.serviceId !== identity.serviceId) throw new Error("identity conflict");
    }
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      digest: digestPayload(payload),
      agentId: identity.agentId,
      serviceId: identity.serviceId,
      timestamp: new Date(now()).toISOString(),
      payload,
    };
    const path = join(directory, `${state}.json`);
    let result = envelope;
    if (!await atomicPublish(path, `${JSON.stringify(envelope)}\n`, io)) {
      result = await read(jobId, state);
      if (result.digest !== envelope.digest || result.agentId !== envelope.agentId || result.serviceId !== envelope.serviceId) {
        throw new Error(`${state} digest conflict`);
      }
    }
    if (TERMINAL_RECORDS.has(state)) {
      await io.rmdir(join(jobPath(jobId), "working")).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await syncDirectory(jobPath(jobId), io);
      await queue.releaseWorker(jobId);
    }
    return result;
  }

  async function writeDeliverable(jobId, markdown, identity) {
    if (typeof markdown !== "string" || Buffer.byteLength(markdown) > MAX_INPUT_BYTES) throw new Error("deliverable exceeds 64KiB");
    const metadata = await record(jobId, "deliverable", { markdownDigest: digestPayload(markdown) }, identity);
    const path = join(jobPath(jobId), "deliverable.md");
    if (!await atomicPublish(path, markdown, io)) {
      const existing = await io.readFile(path, "utf8");
      if (digestPayload(existing) !== metadata.payload.markdownDigest) throw new Error("deliverable digest conflict");
    }
    return metadata;
  }

  function recordMessage(jobId, messageId, payload, identity) {
    if (typeof messageId !== "string" || !messageId) throw new TypeError("messageId required");
    return record(jobId, `message-${digestPayload(messageId)}`, payload, identity);
  }

  queue = createStateQueue({
    root, jobs, io, now, initialize, jobPath,
    isJobId: (jobId) => JOB_ID.test(jobId),
    validJobId, validIdentity, serialize: stableJson, read, record,
  });

  async function readiness() {
    const blockers = new Set();
    try {
      await initialize();
      if (await queue.pendingCount() > 100) blockers.add("pending-capacity");
      if (await directorySize(root, io) > MAX_SPOOL_BYTES) blockers.add("spool-capacity");
      for (const jobId of await io.readdir(jobs)) {
        if (!JOB_ID.test(jobId)) throw new Error("unknown job directory");
        const directory = jobPath(jobId);
        const entries = await io.readdir(directory);
        const accepted = await read(jobId, "accepted");
        if (now() - Date.parse(accepted.timestamp) >= MAX_JOB_AGE_MS) blockers.add("job-expired");
        if (entries.includes("working")) {
          const working = await read(jobId, "working");
          if (now() - Date.parse(working.timestamp) >= STALE_WORKING_MS) blockers.add("stale-working");
        }
        if (entries.includes("delivery-attempt.json") && !TERMINAL_STATES.some((state) => entries.includes(`${state}.json`))) {
          blockers.add("delivery-unknown");
        }
        for (const name of entries) {
          const path = join(directory, name);
          if ((await io.lstat(path)).isSymbolicLink()) throw new Error("symlink in job");
          if (name.endsWith(".json")) await read(jobId, name.slice(0, -5));
          else if (!["ready", "working", "deliverable.md"].includes(name)) throw new Error("unknown state file");
        }
      }
    } catch {
      blockers.add("corrupt-state");
    }
    return { status: blockers.size ? 503 : 200, blockers: [...blockers].sort() };
  }

  return {
    stateDir, root, accept: queue.accept, claimNext: queue.claimNext,
    read, record, recordMessage, readiness, writeDeliverable,
  };
}
