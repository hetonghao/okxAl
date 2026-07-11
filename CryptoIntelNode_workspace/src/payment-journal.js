import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { settledSuccessfully, storedSuccessResponse } from "./payment-journal-settlement.js";

const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(["prepared", "settled", "reconciliation_required"]);
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class PaymentReconciliationError extends Error {
  constructor(message = "payment requires reconciliation") {
    super(message);
    this.name = "PaymentReconciliationError";
    this.status = 503;
    this.code = "payment_reconciliation_required";
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(stable(value))).digest("hex");
}

async function durableWrite(directory, value, io) {
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

function validateState(value, paymentHeaderHash, requestHash) {
  if (
    !value || value.schemaVersion !== 1 || !STATES.has(value.status)
    || value.paymentHeaderHash !== paymentHeaderHash || value.requestHash !== requestHash
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string"
  ) throw new PaymentReconciliationError("invalid payment journal state");
  if (value.status === "settled" && (!value.response || value.response.status < 200 || value.response.status >= 300)) {
    throw new PaymentReconciliationError("invalid settled response");
  }
  return value;
}

export function createPaymentJournal({ stateDir = process.env.CRYPTO_INTEL_STATE_DIR, now = Date.now, ttlMs = DEFAULT_TTL_MS, io = fs } = {}) {
  if (!stateDir) throw new TypeError("stateDir is required");
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive integer");
  const root = join(stateDir, "http", "results");

  function identify(paymentHeader, request) {
    if (typeof paymentHeader !== "string" || paymentHeader.length === 0) throw new TypeError("paymentHeader is required");
    const paymentHeaderHash = digest(paymentHeader);
    const requestHash = digest(request);
    return {
      paymentHeaderHash,
      requestHash,
      directory: join(root, paymentHeaderHash),
    };
  }

  async function read(identity) {
    try {
      const value = JSON.parse(await readFile(join(identity.directory, "state.json"), "utf8"));
      return validateState(value, identity.paymentHeaderHash, identity.requestHash);
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (error instanceof PaymentReconciliationError) throw error;
        throw new PaymentReconciliationError("unreadable payment journal state");
      }
      try {
        await stat(identity.directory);
        throw new PaymentReconciliationError("incomplete payment journal state");
      } catch (directoryError) {
        if (directoryError.code === "ENOENT") return null;
        throw directoryError;
      }
    }
  }

  async function markReconciliation(identity, current) {
    if (current.status !== "reconciliation_required") {
      await durableWrite(identity.directory, {
        ...current,
        status: "reconciliation_required",
        updatedAt: new Date(now()).toISOString(),
      }, io);
    }
    throw new PaymentReconciliationError();
  }

  async function execute({ paymentHeader, request, response, settle, flush, fault = () => {} }) {
    if (!response || !Number.isInteger(response.status) || typeof settle !== "function" || typeof flush !== "function") {
      throw new TypeError("response, settle and flush are required");
    }
    const identity = identify(paymentHeader, request);
    await fault("afterValidate");

    const current = await read(identity);
    if (current?.status === "settled") {
      await flush(current.response);
      return { replayed: true };
    }
    if (current) await markReconciliation(identity, current);

    if (response.status < 200 || response.status >= 300) {
      await flush(response);
      return { replayed: false };
    }
    const storedResponse = storedSuccessResponse(response);

    await fault("beforePreparedWrite");
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      await mkdir(identity.directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const raced = await read(identity);
      if (raced?.status === "settled") {
        await flush(raced.response);
        return { replayed: true };
      }
      if (raced) await markReconciliation(identity, raced);
      throw new PaymentReconciliationError("concurrent payment state is unknown");
    }

    const timestamp = new Date(now()).toISOString();
    const prepared = {
      schemaVersion: 1,
      paymentHeaderHash: identity.paymentHeaderHash,
      requestHash: identity.requestHash,
      status: "prepared",
      response: storedResponse,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await durableWrite(identity.directory, prepared, io);
    await fault("afterPreparedWrite");
    await fault("beforeSettlement");
    const settlement = await settle();
    if (!settledSuccessfully(settlement)) await markReconciliation(identity, prepared);
    await fault("afterSettlement");
    await fault("beforeSettledWrite");
    await durableWrite(identity.directory, {
      ...prepared,
      status: "settled",
      updatedAt: new Date(now()).toISOString(),
    }, io);
    await fault("afterSettledWrite");
    await fault("beforeFlush");
    await flush(storedResponse);
    return { replayed: false };
  }

  async function replay(paymentHeader, request) {
    const identity = identify(paymentHeader, request);
    const current = await read(identity);
    if (!current) return null;
    if (current.status !== "settled") await markReconciliation(identity, current);
    return current.response;
  }

  async function cleanup() {
    let removed = 0;
    let paymentDirectories;
    try {
      paymentDirectories = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
    for (const payment of paymentDirectories) {
      if (!payment.isDirectory() || !HASH.test(payment.name)) continue;
      const paymentDirectory = join(root, payment.name);
      let value;
      try {
        value = JSON.parse(await readFile(join(paymentDirectory, "state.json"), "utf8"));
        validateState(value, payment.name, value?.requestHash);
      } catch (error) {
        if (error instanceof PaymentReconciliationError || error.code === "ENOENT" || error instanceof SyntaxError) continue;
        throw error;
      }
      if (value.status === "settled" && now() - Date.parse(value.updatedAt) >= ttlMs) {
        const { response: _expiredResponse, ...tombstone } = value;
        await durableWrite(paymentDirectory, {
          ...tombstone,
          status: "reconciliation_required",
          updatedAt: new Date(now()).toISOString(),
        }, io);
        removed += 1;
      }
    }
    return removed;
  }

  async function readiness() {
    const blockers = new Set();
    const probe = join(root, `.readiness-${randomUUID()}`);
    let file;
    try {
      await io.mkdir(root, { recursive: true, mode: 0o700 });
      file = await io.open(probe, "wx", 0o600);
      await file.sync();
      await file.close();
      file = null;
      await io.rm(probe);
      for (const entry of await io.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !HASH.test(entry.name)) throw new Error("unknown payment journal entry");
        const value = JSON.parse(await io.readFile(join(root, entry.name, "state.json"), "utf8"));
        validateState(value, entry.name, value?.requestHash);
        if (value.status !== "settled") blockers.add("reconciliation-required");
      }
    } catch {
      blockers.add("journal-unavailable");
    } finally {
      await file?.close().catch(() => {});
      await io.rm(probe, { force: true }).catch(() => blockers.add("journal-unavailable"));
    }
    return { status: blockers.size ? 503 : 200, blockers: [...blockers].sort() };
  }

  return { stateDir, identify, execute, replay, cleanup, readiness };
}
