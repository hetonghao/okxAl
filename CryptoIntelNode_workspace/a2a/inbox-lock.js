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
    if (!observed) return false;
    const age = Date.now() - await io.stat(path).then((value) => value.mtimeMs, () => Date.now());
    if (isAlive(observed.pid) && (!expiring || age < staleMs)) return false;
    const tombstone = `${path}.swap-${randomUUID()}`;
    try {
      await io.rename(path, tombstone);
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
    const moved = await owner(tombstone);
    if (moved?.token !== observed.token) return false;
    await io.rm(tombstone, { recursive: true, force: true });
    await syncDirectory(dirname(path), io);
    return true;
  }

  async function acquire(path, { wait = true, expiring = true } = {}) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const token = randomUUID();
      try {
        await io.mkdir(path, { mode: 0o700 });
        await writeOwner(path, token);
        await syncDirectory(path, io);
        await syncDirectory(dirname(path), io);
        return token;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
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
