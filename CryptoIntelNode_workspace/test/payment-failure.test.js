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
    settle: async () => { settlements += 1; },
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
        if (failure === "parent.sync" && !path.endsWith(".tmp")) {
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
        settle: async () => { settlements += 1; },
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

test("Given the same payment with a different canonical request, when executed, then results never cross", async (context) => {
  const { journal } = await fixture(context);
  await run(journal);
  const different = await run(journal, { request: { ...request, query: { ...request.query, address: "0xdef" } } });
  assert.deepEqual(different, { result: { replayed: false }, settlements: 1, flushes: 1 });
});

test("Given an unknown or truncated state, when read, then it fails closed", async (context) => {
  const { journal } = await fixture(context);
  await assert.rejects(run(journal, { fault: (at) => { if (at === "afterPreparedWrite") throw new Error("crash"); } }));
  const { directory } = journal.identify(paymentHeader, request);
  await writeFile(join(directory, "state.json"), "{truncated", "utf8");
  await assert.rejects(run(createPaymentJournal({ stateDir: journal.stateDir })), PaymentReconciliationError);
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

test("Given expired and fresh records, when cleanup runs, then only expired valid journal entries are removed", async (context) => {
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
  const fresh = await run(journal, { paymentHeader: "fresh-payment" });
  assert.deepEqual(fresh, { result: { replayed: true }, settlements: 0, flushes: 1 });
});
