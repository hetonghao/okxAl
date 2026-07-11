import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PaymentReconciliationError,
  createPaymentJournal,
} from "../src/payment-journal.js";
import { storedSuccessResponse } from "../src/payment-journal-settlement.js";

const request = {
  method: "POST",
  pathname: "/v1/token-risk",
  query: { network: "ethereum", address: "0xabc" },
  body: { focus: "holders" },
};
const response = {
  status: 200,
  body: {
    schemaVersion: "1.0",
    scoreVersion: "risk-v1.0.0",
    requestId: "request-1",
    asset: { network: "eip155:1", address: "0x1111111111111111111111111111111111111111" },
    assessment: { score: 71, level: "high", confidence: 0.85 },
    dimensions: {
      security: { score: 60, status: "fresh" },
      liquidity: { score: 75, status: "fresh" },
      concentration: { score: 90, status: "fresh" },
    },
    freshness: { observedAt: "2026-07-11T00:00:00Z", expiresAt: "2026-07-11T00:05:00Z", stale: false },
    evidence: [{ dimension: "security", source: "alpha", summary: "high risk", observedAt: "2026-07-11T00:00:00Z" }],
    missing: [],
    conflicts: [],
    disclaimer: "For risk research only; not investment advice.",
  },
};
const paymentHeader = "signed-wallet-secret";
const approvedSettlement = {
  network: "eip155:1",
  approvedRequirements: {
    scheme: "exact",
    network: "eip155:1",
    asset: "0x1111111111111111111111111111111111111111",
    amount: "20000",
    payTo: "0x2222222222222222222222222222222222222222",
    extra: { decimals: 6, symbol: "SYNTH" },
  },
};
approvedSettlement.requirements = approvedSettlement.approvedRequirements;
const settlementSuccess = {
  success: true,
  status: "success",
  transaction: `0x${"a".repeat(64)}`,
  network: "eip155:1",
};

async function fixture(context, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "crypto-payment-journal-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, journal: createPaymentJournal({ stateDir, ...options }) };
}

async function run(journal, overrides = {}) {
  let settlements = 0;
  let flushes = 0;
  const result = await journal.execute({
    paymentHeader,
    request,
    response,
    expectedSettlement: approvedSettlement,
    settle: async () => { settlements += 1; return settlementSuccess; },
    flush: async (value) => { flushes += 1; assert.deepEqual(value, response); },
    ...overrides,
  });
  return { result, settlements, flushes };
}

test("Given a paid success, when it settles, then it is durable and replayed without charging again", async (context) => {
  const { stateDir, journal } = await fixture(context);
  const first = await run(journal);
  const replay = await run(createPaymentJournal({ stateDir }));

  assert.deepEqual(first, { result: { replayed: false }, settlements: 1, flushes: 1 });
  assert.deepEqual(replay, { result: { replayed: true }, settlements: 0, flushes: 1 });

  const disk = await readdir(join(stateDir, "http", "results"), { recursive: true });
  const contents = await Promise.all(disk.filter((name) => name.endsWith("state.json")).map(
    (name) => readFile(join(stateDir, "http", "results", name), "utf8"),
  ));
  assert.equal(contents.length, 1);
  assert.equal(contents[0].includes(paymentHeader), false);
  assert.equal(contents[0].includes("0xabc"), false);
  assert.match(contents[0], /"status":"settled"/);
});

test("Given a new payment identity, when the process crashes, then its parent directory entry is durable before settlement", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "crypto-payment-parent-sync-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const root = join(stateDir, "http", "results");
  const events = [];
  let identityDirectory;
  let identityDurable = false;
  let settlements = 0;
  const io = {
    ...fs,
    mkdir: async (path, options) => {
      events.push(`mkdir:${path}`);
      const result = await fs.mkdir(path, options);
      if (path.startsWith(`${root}/`)) identityDirectory = path;
      return result;
    },
    open: async (path, ...args) => {
      events.push(`open:${path}`);
      const handle = await fs.open(path, ...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(`sync:${path}`);
        if (path === root) identityDurable = true;
        return sync();
      };
      return handle;
    },
    rename: async (source, target) => {
      events.push(`rename:${source}->${target}`);
      return fs.rename(source, target);
    },
  };
  const execute = (journal) => journal.execute({
    paymentHeader,
    request,
    response,
    expectedSettlement: approvedSettlement,
    settle: async () => { settlements += 1; return settlementSuccess; },
    flush: async () => {},
  });

  const firstJournal = createPaymentJournal({ stateDir, io });
  identityDirectory = firstJournal.identify(paymentHeader, request).directory;
  await execute(firstJournal);
  if (!identityDurable) await rm(identityDirectory, { recursive: true, force: true });
  await execute(createPaymentJournal({ stateDir }));

  assert.equal(settlements, 1, `crash lost an unsynced identity and settled twice; events=${events.join(" | ")}`);
  const identityMkdir = events.indexOf(`mkdir:${identityDirectory}`);
  const rootSync = events.indexOf(`sync:${root}`);
  const preparedRename = events.findIndex((event) => event.includes("rename:") && event.endsWith("state.json"));
  assert.ok(identityMkdir >= 0 && identityMkdir < rootSync && rootSync < preparedRename, events.join(" | "));
});

test("Given secrets inside a successful body, when persisted, then only public response fields reach disk", async (context) => {
  const { stateDir, journal } = await fixture(context);
  const secrets = ["api-key-secret", "cookie-secret", "wallet-secret", "session-secret"];
  await run(journal, {
    response: {
      ...response,
      body: {
        ...response.body,
        apiKey: secrets[0],
        cookie: secrets[1],
        asset: { ...response.body.asset, wallet: secrets[2] },
        evidence: [{ ...response.body.evidence[0], session: secrets[3] }],
      },
    },
    flush: async (value) => assert.deepEqual(value, response),
  });
  const { directory } = journal.identify(paymentHeader, request);
  const contents = await readFile(join(directory, "state.json"), "utf8");
  for (const secret of [paymentHeader, ...secrets]) {
    assert.equal(contents.includes(secret), false);
  }
});

for (const failure of ["file.sync", "rename", "parent.sync"]) {
  test(`Given ${failure} fails, when persistence is retried, then undurable state is never replayed as settled`, async (context) => {
    let syncs = 0;
    let renames = 0;
    const io = {
      ...fs,
      open: async (path, ...args) => {
        const handle = await fs.open(path, ...args);
        if (failure === "file.sync" && path.endsWith(".tmp")) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { if (++syncs === 2) throw new Error(failure); return sync(); };
        }
        if (failure === "parent.sync" && /[a-f0-9]{64}$/.test(path)) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { if (++syncs === 2) throw new Error(failure); return sync(); };
        }
        return handle;
      },
      rename: failure === "rename" ? async (...args) => {
        if (++renames === 2) throw new Error(failure);
        return fs.rename(...args);
      } : fs.rename,
    };
    const { stateDir, journal } = await fixture(context, { io });
    await assert.rejects(run(journal), new RegExp(failure.replace(".", "\\.")));
    await assert.rejects(run(createPaymentJournal({ stateDir })), PaymentReconciliationError);
  });
}

test("Given the identity parent sync fails, when persistence starts, then settlement and success fail closed", async (context) => {
  let settlements = 0;
  let flushes = 0;
  const { stateDir, journal } = await fixture(context, {
    io: {
      ...fs,
      open: async (path, ...args) => {
        const handle = await fs.open(path, ...args);
        if (path === join(stateDir, "http", "results")) {
          handle.sync = async () => { throw new Error("identity parent sync"); };
        }
        return handle;
      },
    },
  });

  await assert.rejects(run(journal, {
    settle: async () => { settlements += 1; return settlementSuccess; },
    flush: async () => { flushes += 1; },
  }), /identity parent sync/);
  assert.equal(settlements, 0);
  assert.equal(flushes, 0);
  await assert.rejects(stat(journal.identify(paymentHeader, request).directory), { code: "ENOENT" });
});

for (const point of ["afterValidate", "beforePreparedWrite"]) {
  test(`Given a crash ${point}, when retried, then no payment state or duplicate charge exists`, async (context) => {
    const { stateDir, journal } = await fixture(context);
    await assert.rejects(run(journal, { fault: (at) => { if (at === point) throw new Error(point); } }), new RegExp(point));
    const retry = await run(createPaymentJournal({ stateDir }));
    assert.deepEqual(retry, { result: { replayed: false }, settlements: 1, flushes: 1 });
  });
}

for (const point of ["afterPreparedWrite", "beforeSettlement", "afterSettlement", "beforeSettledWrite"]) {
  test(`Given a crash ${point}, when retried, then it reconciles and never charges or returns success`, async (context) => {
    const { stateDir, journal } = await fixture(context);
    await assert.rejects(run(journal, { fault: (at) => { if (at === point) throw new Error(point); } }), new RegExp(point));

    let settlements = 0;
    let flushes = 0;
    await assert.rejects(
      createPaymentJournal({ stateDir }).execute({
        paymentHeader,
        request,
        response,
        expectedSettlement: approvedSettlement,
        settle: async () => { settlements += 1; return settlementSuccess; },
        flush: async () => { flushes += 1; },
      }),
      PaymentReconciliationError,
    );
    assert.equal(settlements, 0);
    assert.equal(flushes, 0);
  });
}

for (const point of ["afterSettledWrite", "beforeFlush"]) {
  test(`Given a crash ${point}, when retried, then settled output replays without another charge`, async (context) => {
    const { stateDir, journal } = await fixture(context);
    await assert.rejects(run(journal, { fault: (at) => { if (at === point) throw new Error(point); } }), new RegExp(point));
    const replay = await run(createPaymentJournal({ stateDir }));
    assert.deepEqual(replay, { result: { replayed: true }, settlements: 0, flushes: 1 });
  });
}

for (const status of [400, 503]) {
  test(`Given a ${status} response, when executed, then it flushes without settlement or journal`, async (context) => {
    const { stateDir, journal } = await fixture(context);
    let settlements = 0;
    let flushed;
    const failure = { status, body: { error: "business failure" } };
    const result = await journal.execute({
      paymentHeader,
      request,
      response: failure,
      settle: async () => { settlements += 1; },
      flush: async (value) => { flushed = value; },
    });
    assert.deepEqual(result, { replayed: false });
    assert.deepEqual(flushed, failure);
    assert.equal(settlements, 0);
    await assert.rejects(stat(join(stateDir, "http", "results")), { code: "ENOENT" });
  });
}

test("Given the same payment proof with a different canonical request, when executed, then it fails closed without a second settlement", async (context) => {
  const { journal } = await fixture(context);
  await run(journal);
  let settlements = 0;
  await assert.rejects(run(journal, {
    request: { ...request, query: { ...request.query, address: "0xdef" } },
    settle: async () => { settlements += 1; return settlementSuccess; },
  }), PaymentReconciliationError);
  assert.equal(settlements, 0);
});

test("Given an unknown or truncated state, when read, then it fails closed", async (context) => {
  const { journal } = await fixture(context);
  await assert.rejects(run(journal, { fault: (at) => { if (at === "afterPreparedWrite") throw new Error("crash"); } }));
  const { directory } = journal.identify(paymentHeader, request);
  await writeFile(join(directory, "state.json"), "{truncated", "utf8");
  await assert.rejects(run(createPaymentJournal({ stateDir: journal.stateDir })), PaymentReconciliationError);
});

for (const [name, corrupt] of [
  ["missing body", (value) => ({ ...value, response: { status: 200 } })],
  ["wrong field type", (value) => ({
    ...value,
    response: { ...value.response, body: { ...value.response.body, schemaVersion: 1 } },
  })],
  ["unparseable createdAt", (value) => ({ ...value, createdAt: "not-a-date" })],
  ["unparseable updatedAt", (value) => ({ ...value, updatedAt: "not-a-date" })],
  ["reverse-ordered timestamps", (value) => ({ ...value, createdAt: "2026-07-12T00:00:01Z", updatedAt: "2026-07-12T00:00:00Z" })],
  ["unknown schema version", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, schemaVersion: "2.0" } } })],
  ["empty score version", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, scoreVersion: "" } } })],
  ["unknown score version", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, scoreVersion: "risk-v2.0.0" } } })],
  ["empty request id", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, requestId: " " } } })],
  ["non-CAIP network", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, asset: { ...value.response.body.asset, network: "ethereum" } } } })],
  ["unsupported network", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, asset: { ...value.response.body.asset, network: "eip155:999" } } } })],
  ["malformed address", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, asset: { ...value.response.body.asset, address: "0xabc" } } } })],
  ["zero address", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, asset: { ...value.response.body.asset, address: `0x${"0".repeat(40)}` } } } })],
  ["out-of-range assessment score", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, assessment: { ...value.response.body.assessment, score: 101 } } } })],
  ["unknown assessment level", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, assessment: { ...value.response.body.assessment, level: "severe" } } } })],
  ["out-of-range confidence", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, assessment: { ...value.response.body.assessment, confidence: 1.01 } } } })],
  ["out-of-range dimension score", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, dimensions: { ...value.response.body.dimensions, security: { ...value.response.body.dimensions.security, score: -1 } } } } })],
  ["unknown dimension status", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, dimensions: { ...value.response.body.dimensions, security: { ...value.response.body.dimensions.security, status: "unknown" } } } } })],
  ["unparseable freshness observedAt", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, freshness: { ...value.response.body.freshness, observedAt: "not-a-date" } } } })],
  ["reverse-ordered freshness", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, freshness: { ...value.response.body.freshness, observedAt: "2026-07-11T00:05:00Z", expiresAt: "2026-07-11T00:00:00Z" } } } })],
  ["unknown evidence dimension", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, evidence: [{ ...value.response.body.evidence[0], dimension: "governance" }] } } })],
  ["empty evidence source", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, evidence: [{ ...value.response.body.evidence[0], source: " " }] } } })],
  ["empty evidence summary", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, evidence: [{ ...value.response.body.evidence[0], summary: "" }] } } })],
  ["unparseable evidence observedAt", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, evidence: [{ ...value.response.body.evidence[0], observedAt: "not-a-date" }] } } })],
  ["evidence observed after freshness expiry", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, evidence: [{ ...value.response.body.evidence[0], observedAt: "2026-07-11T00:06:00Z" }] } } })],
  ["unknown disclaimer", (value) => ({ ...value, response: { ...value.response, body: { ...value.response.body, disclaimer: "Investment advice." } } })],
]) {
  test(`Given a settled response with ${name}, when read, then readiness and replay fail closed`, async (context) => {
    const { journal } = await fixture(context);
    await run(journal);
    const { directory } = journal.identify(paymentHeader, request);
    const path = join(directory, "state.json");
    const value = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, `${JSON.stringify(corrupt(value))}\n`, "utf8");

    assert.deepEqual(await journal.readiness(), { status: 503, blockers: ["journal-unavailable"] });
    await assert.rejects(journal.replay(paymentHeader, request), PaymentReconciliationError);
  });
}

test("Given accessors or inherited response fields, when storing success, then no untrusted value is executed or accepted", () => {
  let getterCalls = 0;
  const accessor = Object.create(response);
  Object.defineProperty(accessor, "status", {
    enumerable: true,
    get() { getterCalls += 1; return 200; },
  });

  assert.throws(() => storedSuccessResponse(accessor), TypeError);
  assert.equal(getterCalls, 0);
  assert.throws(() => storedSuccessResponse(Object.create(response)), TypeError);

  const evidence = [...response.body.evidence];
  Object.defineProperty(evidence, "0", { get() { getterCalls += 1; return response.body.evidence[0]; } });
  assert.throws(() => storedSuccessResponse({ ...response, body: { ...response.body, evidence } }), TypeError);
  assert.equal(getterCalls, 0);
});

test("Given settlement reports failure, when executed, then success is withheld and the payment is reconciled", async (context) => {
  const { stateDir, journal } = await fixture(context);
  let flushes = 0;
  await assert.rejects(run(journal, {
    settle: async () => ({ success: false }),
    flush: async () => { flushes += 1; },
  }), PaymentReconciliationError);
  assert.equal(flushes, 0);
  await assert.rejects(run(createPaymentJournal({ stateDir })), PaymentReconciliationError);
});

test("Given the SDK returns its complete success shape without the optional status extension, when executed, then it settles", async (context) => {
  const { journal } = await fixture(context);
  const { status: _optionalStatus, ...sdkSuccess } = settlementSuccess;
  const result = await run(journal, { settle: async () => sdkSuccess });
  assert.deepEqual(result.result, { replayed: false });
});

for (const [name, settlement] of [
  ["null", null],
  ["undefined", undefined],
  ["incomplete success", { success: true }],
  ["pending success", { ...settlementSuccess, status: "pending" }],
  ["success without transaction", { ...settlementSuccess, transaction: "" }],
  ["success with blank transaction", { ...settlementSuccess, transaction: "   " }],
  ["success with malformed transaction", { ...settlementSuccess, transaction: "0xsettled" }],
  ["success without network", { ...settlementSuccess, network: "" }],
  ["success on an attacker network", { ...settlementSuccess, network: "eip155:666" }],
]) {
  test(`Given settlement returns ${name}, when executed, then it requires reconciliation and never flushes success`, async (context) => {
    const { stateDir, journal } = await fixture(context);
    let flushes = 0;
    await assert.rejects(run(journal, {
      settle: async () => settlement,
      flush: async () => { flushes += 1; },
    }), PaymentReconciliationError);
    assert.equal(flushes, 0);
    await assert.rejects(run(createPaymentJournal({ stateDir })), PaymentReconciliationError);
  });
}

test("Given settlement requirements differ from the approved identity, when settlement succeeds, then it reconciles without flushing", async (context) => {
  const { stateDir, journal } = await fixture(context);
  let settlements = 0;
  let flushes = 0;
  await assert.rejects(run(journal, {
    expectedSettlement: {
      ...approvedSettlement,
      requirements: { ...approvedSettlement.requirements, amount: "999" },
    },
    settle: async () => { settlements += 1; return settlementSuccess; },
    flush: async () => { flushes += 1; },
  }), PaymentReconciliationError);
  assert.equal(settlements, 0);
  assert.equal(flushes, 0);
  await assert.rejects(run(createPaymentJournal({ stateDir })), PaymentReconciliationError);
});

test("Given inherited or accessor settlement fields, when settlement is validated, then own-data checks fail without executing getters", async (context) => {
  const inherited = Object.create(settlementSuccess);
  let getterCalls = 0;
  const accessor = { ...settlementSuccess };
  Object.defineProperty(accessor, "transaction", { get() { getterCalls += 1; return settlementSuccess.transaction; } });

  for (const settlement of [inherited, accessor]) {
    const { journal } = await fixture(context);
    await assert.rejects(run(journal, { settle: async () => settlement }), PaymentReconciliationError);
  }
  assert.equal(getterCalls, 0);
});

test("Given expired and fresh records, when cleanup runs, then expired responses become reconciliation tombstones and cannot be charged again", async (context) => {
  let now = Date.parse("2026-07-11T00:00:00.000Z");
  const { stateDir, journal } = await fixture(context, { now: () => now });
  await run(journal);
  now += 14 * 60 * 1000;
  await run(journal, { paymentHeader: "fresh-payment" });
  const outside = join(stateDir, "keep.txt");
  await writeFile(outside, "keep", "utf8");
  now += 2 * 60 * 1000;

  assert.equal(await journal.cleanup(), 1);
  assert.equal(await readFile(outside, "utf8"), "keep");
  let settlements = 0;
  await assert.rejects(run(journal, {
    settle: async () => { settlements += 1; return settlementSuccess; },
  }), PaymentReconciliationError);
  assert.equal(settlements, 0);
  const fresh = await run(journal, { paymentHeader: "fresh-payment" });
  assert.deepEqual(fresh, { result: { replayed: true }, settlements: 0, flushes: 1 });
});
