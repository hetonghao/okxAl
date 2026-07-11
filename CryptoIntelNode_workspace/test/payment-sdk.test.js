import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import express from "express";

import {
  ExactEvmScheme,
  OKXFacilitatorClient,
  paymentMiddleware,
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
} from "../src/payment-sdk.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function serve(httpServer, handler) {
  const app = express();
  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
  app.get("/paid", handler);
  const server = createServer(app);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  return {
    request: (payment = true) => fetch(`http://127.0.0.1:${port}/paid`, {
      headers: payment ? { "payment-signature": "signed" } : {},
    }),
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => (
      error ? rejectClose(error) : resolveClose()
    ))),
  };
}

function fakeHTTPServer({ processHTTPRequest, processSettlement = async () => ({ success: true, headers: {} }) }) {
  return {
    registerPaywallProvider() {},
    initialize: async () => {},
    requiresPayment: () => true,
    processHTTPRequest,
    processSettlement,
  };
}

const verified = {
  type: "payment-verified",
  paymentPayload: { payment: "signed" },
  paymentRequirements: { amount: "1" },
  declaredExtensions: {},
};

test("Given the pinned SDK adapter, when loaded, then official exports are available", () => {
  // Given / When
  const exports = [
    ExactEvmScheme,
    OKXFacilitatorClient,
    paymentMiddleware,
    paymentMiddlewareFromHTTPServer,
    x402ResourceServer,
  ];

  // Then
  for (const value of exports) assert.equal(typeof value, "function");
});

test("Given the lockfile, when inspected, then exact versions and licenses are pinned", async () => {
  // Given / When
  const lock = JSON.parse(await readFile(resolve(workspace, "package-lock.json"), "utf8"));
  const expected = {
    "@okxweb3/x402-core": ["0.1.0", "Apache-2.0"],
    "@okxweb3/x402-evm": ["0.2.1", "Apache-2.0"],
    "@okxweb3/x402-express": ["0.1.1", "Apache-2.0"],
    express: ["5.2.1", "MIT"],
  };

  // Then
  assert.deepEqual(lock.packages[""].dependencies, Object.fromEntries(
    Object.entries(expected).map(([name, [version]]) => [name, version]),
  ));
  for (const [name, [version, license]] of Object.entries(expected)) {
    assert.deepEqual(
      [lock.packages[`node_modules/${name}`].version, lock.packages[`node_modules/${name}`].license],
      [version, license],
    );
  }
  assert.equal(Object.keys(lock.packages).some((name) => name.includes("app-x402")), false);
});

test("Given no payment, when middleware runs, then it returns the official 402 response without executing the handler", async (context) => {
  // Given
  let handled = 0;
  const httpServer = fakeHTTPServer({
    processHTTPRequest: async () => ({
      type: "payment-error",
      response: { status: 402, headers: { "payment-required": "challenge" }, body: { error: "payment required" }, isHtml: false },
    }),
  });
  const service = await serve(httpServer, (_request, response) => { handled += 1; response.json({ ok: true }); });
  context.after(service.close);

  // When
  const response = await service.request(false);

  // Then
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("payment-required"), "challenge");
  assert.deepEqual(await response.json(), { error: "payment required" });
  assert.equal(handled, 0);
});

test("Given verified payment, when a 2xx handler ends, then settlement receives the body once before it is flushed", async (context) => {
  // Given
  let settle;
  const settlementStarted = new Promise((resolveStarted) => { settle = resolveStarted; });
  let release;
  const settlementReleased = new Promise((resolveRelease) => { release = resolveRelease; });
  let settlements = 0;
  const httpServer = fakeHTTPServer({
    processHTTPRequest: async () => verified,
    processSettlement: async (_payload, _requirements, _extensions, transport) => {
      settlements += 1;
      settle(transport.responseBody.toString());
      await settlementReleased;
      return { success: true, headers: { "x-payment-response": "settled" } };
    },
  });
  const service = await serve(httpServer, (_request, response) => response.status(200).json({ ok: true }));
  context.after(service.close);

  // When
  let flushed = false;
  const pendingResponse = service.request().then((response) => { flushed = true; return response; });
  const bufferedBody = await settlementStarted;

  // Then
  assert.equal(bufferedBody, JSON.stringify({ ok: true }));
  assert.equal(flushed, false);
  release();
  const response = await pendingResponse;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-payment-response"), "settled");
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(settlements, 1);
});

for (const status of [400, 503]) {
  test(`Given verified payment, when the handler returns ${status}, then settlement is skipped`, async (context) => {
    // Given
    let settlements = 0;
    const httpServer = fakeHTTPServer({
      processHTTPRequest: async () => verified,
      processSettlement: async () => { settlements += 1; return { success: true, headers: {} }; },
    });
    const service = await serve(httpServer, (_request, response) => response.status(status).json({ error: "business failure" }));
    context.after(service.close);

    // When
    const response = await service.request();

    // Then
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: "business failure" });
    assert.equal(settlements, 0);
  });
}

test("Given settlement failure, when the handler produced success, then the success body is not leaked", async (context) => {
  // Given
  let settlements = 0;
  const httpServer = fakeHTTPServer({
    processHTTPRequest: async () => verified,
    processSettlement: async () => {
      settlements += 1;
      return { success: false, response: { status: 402, headers: {}, body: { error: "settlement failed" }, isHtml: false } };
    },
  });
  const service = await serve(httpServer, (_request, response) => response.status(200).json({ secret: "paid result" }));
  context.after(service.close);

  // When
  const response = await service.request();

  // Then
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { error: "settlement failed" });
  assert.equal(settlements, 1);
});

test("Given a duplicate replay, when requested twice, then the fake rejects it before a second handler or settlement", async (context) => {
  // Given
  let requests = 0;
  let handled = 0;
  let settlements = 0;
  const httpServer = fakeHTTPServer({
    processHTTPRequest: async () => {
      requests += 1;
      return requests === 1 ? verified : {
        type: "payment-error",
        response: { status: 402, headers: {}, body: { error: "duplicate" }, isHtml: false },
      };
    },
    processSettlement: async () => { settlements += 1; return { success: true, headers: {} }; },
  });
  const service = await serve(httpServer, (_request, response) => { handled += 1; response.json({ ok: true }); });
  context.after(service.close);

  // When
  const first = await service.request();
  const replay = await service.request();

  // Then
  assert.equal(first.status, 200);
  assert.equal(replay.status, 402);
  assert.equal(handled, 1);
  assert.equal(settlements, 1);
});

test("Given malformed payment-error data, when middleware runs, then it fails closed without executing the handler", async (context) => {
  // Given
  let handled = 0;
  const httpServer = fakeHTTPServer({
    processHTTPRequest: async () => ({
      type: "payment-error",
      response: { status: 402, headers: {}, body: undefined, isHtml: false },
    }),
  });
  const service = await serve(httpServer, (_request, response) => { handled += 1; response.json({ ok: true }); });
  context.after(service.close);

  // When
  const response = await service.request();

  // Then
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), {});
  assert.equal(handled, 0);
});
