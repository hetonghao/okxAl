import * as fs from "node:fs/promises";
import { join } from "node:path";

import { atomicPublish, recoverAtomicPublishes, syncDirectory } from "./state-io.js";

const JOB_ID = /^0x[0-9a-f]{64}$/;
const MAX_JOBS = 100;
const MAX_REQUEST_BYTES = 4096;

export function createA2AInbox({ stateDir, io = fs } = {}) {
  const root = join(stateDir, "a2a-inbox");
  let initialized = false;

  function jobPath(jobId, name = "") {
    if (!JOB_ID.test(jobId)) throw new TypeError("jobId must be lowercase 32-byte hex");
    return join(root, jobId, name);
  }

  async function initialize() {
    if (initialized) return;
    await io.mkdir(root, { recursive: true, mode: 0o700 });
    await recoverAtomicPublishes(root, JOB_ID, io);
    initialized = true;
  }

  async function read(jobId, name) {
    await initialize();
    const path = jobPath(jobId, name);
    if ((await io.lstat(path)).isSymbolicLink()) throw new Error("symlink in inbox");
    return JSON.parse(await io.readFile(path, "utf8"));
  }

  async function reserve(jobId) {
    await initialize();
    const directory = jobPath(jobId);
    try {
      await io.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") return true;
      throw error;
    }
    const entries = await io.readdir(root, { withFileTypes: true });
    const count = entries.filter((entry) => entry.isDirectory() && JOB_ID.test(entry.name)).length;
    if (count <= MAX_JOBS) {
      await syncDirectory(root, io);
      return true;
    }
    await io.rm(directory, { recursive: true, force: true });
    await syncDirectory(root, io);
    return false;
  }

  async function claim(jobId, request, senderAgentId, requestDigest) {
    const serialized = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) return { status: "blocked-capacity" };
    if (!await reserve(jobId)) return { status: "blocked-capacity" };
    if (!await atomicPublish(jobPath(jobId, "request.json"), serialized, io)) {
      const saved = await read(jobId, "request.json");
      if (JSON.stringify(saved) !== JSON.stringify(request)) return { status: "blocked-identity" };
    }
    const marker = { senderAgentId, requestDigest };
    if (await atomicPublish(jobPath(jobId, "message.json"), `${JSON.stringify(marker)}\n`, io)) return { status: "claimed" };
    const saved = await read(jobId, "message.json");
    return saved.senderAgentId === senderAgentId && saved.requestDigest === requestDigest
      ? { status: "duplicate" }
      : { status: "blocked-identity" };
  }

  async function cleanup(jobId) {
    await initialize();
    await io.rm(jobPath(jobId), { recursive: true, force: true });
    await syncDirectory(root, io);
  }

  return { claim, cleanup, readRequest: (jobId) => read(jobId, "request.json") };
}
