import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { directorySize, syncDirectory } from "./state-io.js";

const MAX_PENDING = 100;
const MAX_SPOOL_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const TERMINAL_RECORDS = new Set(["submitted", "completed", "failed", "delivery-unknown"]);

export function createStateQueue({ root, jobs, io, now, initialize, jobPath, isJobId, validJobId, validIdentity, serialize, read, record }) {
  const workerFile = join(root, "worker.json");
  const workerJobFile = join(root, "worker-job.json");
  const instanceToken = randomUUID();
  let acceptance = Promise.resolve();
  let claiming = Promise.resolve();

  async function createExclusive(path, value) {
    const handle = await io.open(path, "wx", 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(root, io);
  }

  function processAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  }

  async function electRecovery(parent, prefix) {
    const name = `${prefix}.${process.pid}.${instanceToken}`;
    const candidate = join(parent, name);
    try { await io.mkdir(candidate); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    for (;;) {
      const names = await io.readdir(parent).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      const first = names.filter((entry) => entry.startsWith(`${prefix}.`)).sort()[0];
      if (!first) return null;
      if (first === name) return candidate;
      const pid = Number(first?.split(".")[1]);
      if (first && !processAlive(pid)) {
        await io.rm(join(parent, first), { recursive: true, force: true });
        continue;
      }
      await io.rm(candidate, { recursive: true, force: true });
      return null;
    }
  }

  async function releaseWorkerOwnership(token) {
    const recovery = await electRecovery(root, "worker-recover");
    if (!recovery) return;
    try {
      const owner = await io.readFile(workerFile, "utf8").then(JSON.parse, () => null);
      if (owner?.token !== token) return;
      const claimed = await io.readFile(workerJobFile, "utf8").then(JSON.parse, () => null);
      if (claimed?.token === token) await io.unlink(workerJobFile);
      await io.unlink(workerFile);
      await syncDirectory(root, io);
    } finally {
      await io.rm(recovery, { recursive: true, force: true });
    }
  }

  async function releaseWorker(jobId, expectedToken) {
    const claimed = await io.readFile(workerJobFile, "utf8").then(JSON.parse, () => null);
    if (!claimed || claimed.jobId !== jobId || (expectedToken && claimed.token !== expectedToken)) return;
    await releaseWorkerOwnership(claimed.token);
  }

  async function acquireWorker(workerId) {
    const owner = { workerId, pid: process.pid, token: instanceToken };
    for (;;) {
      try { await createExclusive(workerFile, `${JSON.stringify(owner)}\n`); return true; } catch (error) { if (error.code !== "EEXIST") throw error; }
      const existing = JSON.parse(await io.readFile(workerFile, "utf8"));
      if (existing.token === instanceToken) return existing.workerId === workerId;
      if (processAlive(existing.pid)) return false;
      const recovery = await electRecovery(root, "worker-recover");
      if (!recovery) { await new Promise((resolve) => setTimeout(resolve, 1)); continue; }
      try {
        const current = await io.readFile(workerFile, "utf8").then(JSON.parse, () => null);
        if (current?.token === existing.token) {
          const claimed = await io.readFile(workerJobFile, "utf8").then(JSON.parse, () => null);
          if (claimed?.token === existing.token) await io.unlink(workerJobFile);
          await io.unlink(workerFile);
        }
      } finally {
        await io.rm(recovery, { recursive: true, force: true });
      }
    }
  }

  async function pendingCount() {
    await initialize();
    let count = 0;
    for (const name of await io.readdir(jobs)) {
      const ready = join(jobs, name, "ready");
      if (await io.lstat(ready).then((entry) => entry.isDirectory(), () => false)) count += 1;
    }
    return count;
  }

  async function acceptOnce(input) {
    const incomingBytes = Buffer.byteLength(serialize(input));
    if (incomingBytes > MAX_INPUT_BYTES) throw new Error("input exceeds 64KiB");
    const { jobId, request, accepted, agentId, serviceId } = input;
    validJobId(jobId);
    const identity = { agentId, serviceId };
    validIdentity(identity);
    await initialize();
    if (await directorySize(root, io) + incomingBytes >= MAX_SPOOL_BYTES) throw new Error("spool capacity exceeded");
    const directory = jobPath(jobId);
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    const ready = join(directory, "ready");
    const alreadyAccepted = await io.lstat(join(directory, "accepted.json")).then(() => true, () => false);
    if (!alreadyAccepted && await pendingCount() >= MAX_PENDING) throw new Error("pending capacity exceeded");
    await record(jobId, "request", request, identity);
    const result = await record(jobId, "accepted", accepted, identity);
    const entries = await io.readdir(directory);
    if ([...TERMINAL_RECORDS].some((state) => entries.includes(`${state}.json`))) return result;
    await io.mkdir(ready, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await syncDirectory(directory, io);
    return result;
  }

  async function acceptLocked(input) {
    await initialize();
    const gate = join(root, ".accepting");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await io.mkdir(gate);
        try {
          await io.writeFile(join(gate, "owner"), String(process.pid), { flag: "wx", mode: 0o600 });
        } catch (error) {
          await io.rm(gate, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if (error.code !== "EEXIST" || attempt >= 30_000) throw error;
        let ownerText = await io.readFile(join(gate, "owner"), "utf8").catch(() => "");
        if (!ownerText) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          ownerText = await io.readFile(join(gate, "owner"), "utf8").catch(() => "");
          const age = await io.stat(gate).then((entry) => now() - entry.mtimeMs, () => -1);
          if (!ownerText && age < 1_000) continue;
        }
        const owner = Number(ownerText);
        let alive = owner > 0;
        if (alive) {
          try { process.kill(owner, 0); } catch (probe) { alive = probe.code !== "ESRCH"; }
        }
        if (!alive) {
          const recovery = await electRecovery(gate, "recover");
          if (!recovery) continue;
          const tombstone = `${gate}.recover-${process.pid}-${randomUUID()}`;
          try {
            await io.rename(gate, tombstone);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            continue;
          }
          await io.rm(tombstone, { recursive: true, force: true });
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    try {
      return await acceptOnce(input);
    } finally {
      await io.rm(gate, { recursive: true, force: true });
    }
  }

  function accept(input) {
    const result = acceptance.then(() => acceptLocked(input));
    acceptance = result.catch(() => {});
    return result;
  }

  async function claimNextLocked(workerId) {
    if (typeof workerId !== "string" || !workerId) throw new TypeError("workerId required");
    await initialize();
    if (!await acquireWorker(workerId)) return null;
    const jobIds = (await io.readdir(jobs)).sort();
    for (const jobId of jobIds) {
      if (!isJobId(jobId)) continue;
      const workingDirectory = join(jobPath(jobId), "working");
      if (!await io.lstat(workingDirectory).then((entry) => entry.isDirectory(), () => false)) continue;
      const entries = await io.readdir(jobPath(jobId));
      if ([...TERMINAL_RECORDS].some((state) => entries.includes(`${state}.json`))) {
        await io.rmdir(workingDirectory);
        await syncDirectory(jobPath(jobId), io);
        continue;
      }
      let working;
      try {
        working = await read(jobId, "working");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (now() - (await io.stat(workingDirectory)).mtimeMs >= 1_000) await io.rename(workingDirectory, join(jobPath(jobId), "ready"));
        continue;
      }
      if (working.payload.workerId === workerId) {
        await io.writeFile(workerJobFile, `${JSON.stringify({ token: instanceToken, jobId })}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
        return { jobId, workerId, recovered: true };
      }
    }
    for (const jobId of jobIds) {
      if (!isJobId(jobId)) continue;
      const directory = jobPath(jobId);
      try {
        await io.rename(join(directory, "ready"), join(directory, "working"));
      } catch (error) {
        if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) continue;
        throw error;
      }
      const accepted = await read(jobId, "accepted");
      try {
        await record(jobId, "working", { workerId }, accepted);
        await io.writeFile(workerJobFile, `${JSON.stringify({ token: instanceToken, jobId })}\n`, { flag: "wx", mode: 0o600 });
        await syncDirectory(root, io);
        await syncDirectory(directory, io);
        return { jobId, workerId };
      } catch (error) {
        const durable = await io.lstat(join(directory, "working.json")).then(() => true, () => false);
        if (!durable) await io.rename(join(directory, "working"), join(directory, "ready"));
        await releaseWorkerOwnership(instanceToken);
        throw error;
      }
    }
    await releaseWorkerOwnership(instanceToken);
    return null;
  }

  function claimNext(workerId) {
    const result = claiming.then(() => claimNextLocked(workerId));
    claiming = result.catch(() => {});
    return result;
  }

  return { accept, claimNext, pendingCount, releaseWorker };
}
