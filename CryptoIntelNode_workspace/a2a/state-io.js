import { randomUUID } from "node:crypto";
import { join } from "node:path";

export async function syncDirectory(path, io) {
  const handle = await io.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicPublish(path, content, io) {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const suffix = `${process.pid}-${randomUUID()}`;
  const temp = join(parent, `.${path.slice(path.lastIndexOf("/") + 1)}.${suffix}.tmp`);
  const committed = `${temp}.committed`;
  let handle;
  try {
    handle = await io.open(temp, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await io.rename(temp, committed);
    await io.link(committed, path);
    await io.unlink(committed);
    await syncDirectory(parent, io);
    return true;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await io.unlink(temp).catch(() => {});
    await io.unlink(committed).catch(() => {});
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export async function directorySize(path, io) {
  let total = 0;
  const entries = await io.readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error("symlink in spool");
    total += entry.isDirectory() ? await directorySize(child, io) : await io.stat(child).then((value) => value.size, (error) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
  }
  return total;
}

export async function recoverAtomicPublishes(jobs, jobIdPattern, io) {
  for (const jobId of await io.readdir(jobs)) {
    if (!jobIdPattern.test(jobId)) continue;
    const directory = join(jobs, jobId);
    for (const name of await io.readdir(directory)) {
      const match = name.match(/^\.(deliverable\.md|[a-z0-9-]+\.json)\.\d+-[0-9a-f-]+\.tmp\.committed$/);
      if (!match) continue;
      await io.link(join(directory, name), join(directory, match[1])).catch((error) => {
        if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
      });
      await io.unlink(join(directory, name)).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await syncDirectory(directory, io);
    }
  }
}
