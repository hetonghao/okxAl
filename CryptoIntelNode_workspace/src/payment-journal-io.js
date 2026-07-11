import { randomUUID } from "node:crypto";
import { join } from "node:path";

export async function durableWrite(directory, value, io) {
  const target = join(directory, "state.json");
  const temporary = join(directory, `.state-${randomUUID()}.tmp`);
  const file = await io.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await io.rename(temporary, target);
  const parent = await io.open(directory, "r");
  try {
    await parent.sync();
  } catch (error) {
    await io.rm(target, { force: true }).catch(() => {});
    throw error;
  } finally {
    await parent.close();
  }
}

async function syncDirectory(directory, io) {
  const handle = await io.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durableMkdir(directory, parent, io) {
  try {
    await io.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    await syncDirectory(parent, io);
  } catch (error) {
    await io.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return true;
}
