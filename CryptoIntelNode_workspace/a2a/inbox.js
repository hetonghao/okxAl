import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { atomicPublish, recoverAtomicPublishes, syncDirectory } from "./state-io.js";
import { createInboxLocks } from "./inbox-lock.js";

const JOB_ID = /^0x[0-9a-f]{64}$/;
const MAX_JOBS = 100;
const MAX_SENDER_JOBS = 10;
const MAX_REQUEST_BYTES = 4096;
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const LOCAL_LOCKS = new Map();

export function createA2AInbox({ stateDir, io = fs, now = Date.now, staleMs = DEFAULT_STALE_MS } = {}) {
  const root = join(stateDir, "a2a-inbox");
  const capacityLock = join(root, ".capacity-lock");
  const commitLock = join(root, ".capacity-commit-lock");
  const locks = createInboxLocks({ io });
  let initialized = false;
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  function jobPath(jobId, name = "") {
    if (!JOB_ID.test(jobId)) throw new TypeError("jobId must be lowercase 32-byte hex");
    return join(root, jobId, name);
  }

  async function initialize() {
    if (initialized) return;
    await io.mkdir(root, { recursive: true, mode: 0o700 });
    await locks.recoverTombstones(capacityLock);
    await locks.recoverTombstones(commitLock);
    await recoverAtomicPublishes(root, JOB_ID, io);
    initialized = true;
  }

  async function read(jobId, name) {
    await initialize();
    const path = jobPath(jobId, name);
    if ((await io.lstat(path)).isSymbolicLink()) throw new Error("symlink in inbox");
    return JSON.parse(await io.readFile(path, "utf8"));
  }

  async function withCapacityLock(operation) {
    const previous = LOCAL_LOCKS.get(root) ?? Promise.resolve();
    let releaseLocal;
    const current = new Promise((resolve) => { releaseLocal = resolve; });
    LOCAL_LOCKS.set(root, current);
    await previous;
    try {
      await initialize();
      const token = await locks.acquire(capacityLock);
      try {
        return await operation(token);
      } finally {
        await locks.release(capacityLock, token);
      }
    } finally {
      releaseLocal();
      if (LOCAL_LOCKS.get(root) === current) LOCAL_LOCKS.delete(root);
    }
  }

  async function capacityDecision(senderAgentId) {
    const entries = (await io.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && JOB_ID.test(entry.name));
    if (entries.length >= MAX_JOBS && now() - lastSweepAt < Math.min(staleMs, 1000)) return "blocked-capacity";
    const markers = await activeMarkers(entries);
    if (markers.length >= MAX_JOBS) return "blocked-capacity";
    if (markers.filter((marker) => marker.senderAgentId === senderAgentId).length >= MAX_SENDER_JOBS) {
      return "blocked-sender-capacity";
    }
    return null;
  }

  async function activeMarkers(entries) {
    const markers = [];
    let removed = false;
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      let marker;
      try {
        marker = await read(entry.name, "message.json");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await io.rm(jobPath(entry.name), { recursive: true, force: true });
        removed = true;
        continue;
      }
      if (Number.isFinite(marker.createdAt) && now() - marker.createdAt >= staleMs) {
        await io.rm(jobPath(entry.name), { recursive: true, force: true });
        removed = true;
        continue;
      }
      markers.push(marker);
    }
    if (removed) await syncDirectory(root, io);
    lastSweepAt = now();
    return markers;
  }

  async function existingClaim(jobId, senderAgentId, requestDigest) {
    try {
      const marker = await read(jobId, "message.json");
      if (marker.senderAgentId !== senderAgentId || marker.requestDigest !== requestDigest) return { status: "blocked-identity" };
      try {
        await read(jobId, "acknowledged.json");
        return { status: "duplicate" };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return { status: "retry-ack" };
      }
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function claim(jobId, request, senderAgentId, requestDigest) {
    const serialized = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) return { status: "blocked-capacity" };
    return withCapacityLock(async (capacityToken) => {
      const existing = await existingClaim(jobId, senderAgentId, requestDigest);
      if (existing) return existing;
      const decision = await capacityDecision(senderAgentId);
      if (decision) return { status: decision };
      const staging = join(root, `.claim-${randomUUID()}`);
      await io.mkdir(staging, { mode: 0o700 });
      try {
        await atomicPublish(join(staging, "request.json"), serialized, io);
        const marker = { status: "claimed", senderAgentId, requestDigest, createdAt: now() };
        await atomicPublish(join(staging, "message.json"), `${JSON.stringify(marker)}\n`, io);
        const commitToken = await locks.acquire(commitLock, { expiring: false });
        try {
          if (!await locks.owns(capacityLock, capacityToken)) return { status: "blocked-capacity" };
          const repeated = await existingClaim(jobId, senderAgentId, requestDigest);
          if (repeated) return repeated;
          const finalDecision = await capacityDecision(senderAgentId);
          if (finalDecision) return { status: finalDecision };
          await io.rename(staging, jobPath(jobId));
          await syncDirectory(root, io);
          return { status: "claimed" };
        } finally {
          await locks.release(commitLock, commitToken);
        }
      } catch (error) {
        throw error;
      } finally {
        await io.rm(staging, { recursive: true, force: true });
      }
    });
  }

  async function beginAck(jobId) {
    await initialize();
    try {
      await read(jobId, "acknowledged.json");
      return false;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const lock = jobPath(jobId, ".ack-lock");
    return locks.acquire(lock, { wait: false });
  }

  async function finishAck(jobId, token, acknowledged) {
    const lock = jobPath(jobId, ".ack-lock");
    try {
      if (acknowledged && await locks.owns(lock, token)) {
        await atomicPublish(jobPath(jobId, "acknowledged.json"), `${JSON.stringify({ status: "acknowledged", createdAt: now() })}\n`, io);
      }
    } finally {
      await locks.release(lock, token);
      await syncDirectory(jobPath(jobId), io);
    }
  }

  async function cleanup(jobId) {
    await initialize();
    await io.rm(jobPath(jobId), { recursive: true, force: true });
    await syncDirectory(root, io);
  }

  return { claim, beginAck, finishAck, cleanup, readRequest: (jobId) => read(jobId, "request.json") };
}
