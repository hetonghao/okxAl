import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { syncDirectory } from "./state-io.js";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function createInboxLocks({ io, staleMs = 30_000 }) {
  async function owner(path) {
    return io.readFile(join(path, "owner.json"), "utf8").then(JSON.parse, () => null);
  }

  async function writeOwner(path, token) {
    const handle = await io.open(join(path, "owner.json"), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, state: "active" })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function publishOwner(path, token) {
    const staging = `${path}.init-${process.pid}-${token}`;
    await io.mkdir(staging, { mode: 0o700 });
    try {
      await writeOwner(staging, token);
      await syncDirectory(staging, io);
      await io.rename(staging, path);
      await syncDirectory(dirname(path), io);
    } finally {
      await io.rm(staging, { recursive: true, force: true });
    }
  }

  async function owns(path, token) {
    const current = await owner(path);
    return current?.state === "active" && current.token === token;
  }

  async function recoverTombstones(path) {
    const parent = dirname(path);
    const prefix = `${basename(path)}.swap-`;
    for (const name of await io.readdir(parent)) {
      if (!name.startsWith(prefix)) continue;
      const tombstone = join(parent, name);
      const value = await owner(tombstone);
      if (value?.state !== "active" || typeof value.token !== "string" || value.token.length === 0) {
        throw new Error(`corrupt inbox lock tombstone: ${name}`);
      }
      await io.rm(tombstone, { recursive: true, force: true });
    }
    await syncDirectory(parent, io);
  }

  async function recoverInitializations(path) {
    const parent = dirname(path);
    const prefix = `${basename(path)}.init-`;
    let removed = false;
    for (const name of await io.readdir(parent)) {
      if (!name.startsWith(prefix)) continue;
      const encodedPid = Number.parseInt(name.slice(prefix.length).split("-", 1)[0], 10);
      const value = await owner(join(parent, name));
      if (isAlive(encodedPid) || isAlive(value?.pid)) continue;
      await io.rm(join(parent, name), { recursive: true, force: true });
      removed = true;
    }
    if (removed) await syncDirectory(parent, io);
  }

  async function release(path, token) {
    if (!await owns(path, token)) return false;
    const tombstone = `${path}.swap-${token}`;
    try {
      await io.rename(path, tombstone);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (!await owns(tombstone, token)) return false;
    await io.rm(tombstone, { recursive: true, force: true });
    await syncDirectory(dirname(path), io);
    return true;
  }

  async function removeAbandoned(path, expiring) {
    const observed = await owner(path);
    const age = Date.now() - await io.stat(path).then((value) => value.mtimeMs, () => Date.now());
    if (!observed && age < staleMs) return false;
    if (isAlive(observed?.pid) && (!expiring || age < staleMs)) return false;
    const tombstone = `${path}.swap-${randomUUID()}`;
    try {
      await io.rename(path, tombstone);
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
    const moved = await owner(tombstone);
    if (observed && moved?.token !== observed.token) return false;
    if (!observed && moved) return false;
    await io.rm(tombstone, { recursive: true, force: true });
    await syncDirectory(dirname(path), io);
    return true;
  }

  async function acquire(path, { wait = true, expiring = true } = {}) {
    const deadline = Date.now() + 15_000;
    await recoverInitializations(path);
    while (Date.now() < deadline) {
      const token = randomUUID();
      try {
        await publishOwner(path, token);
        return token;
      } catch (error) {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
        if (!await removeAbandoned(path, expiring)) {
          if (!wait) return false;
          await pause(2);
        }
      }
    }
    throw new Error("inbox lock timeout");
  }

  return { acquire, owns, recoverTombstones, release };
}
