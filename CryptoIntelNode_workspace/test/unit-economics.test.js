import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGates } from "../scripts/check-gates.js";
import { approvedSource, readyFixture } from "./source-policy.test.js";

const now = "2026-07-11T00:00:00.000Z";

test("Given zero cache hits and maximum retries, when economics run, then contribution uses the fixed formula", () => {
  const result = evaluateGates(readyFixture(), now);
  assert.equal(result.economics.netContributionUsd, 0.015);
  assert.equal(result.ready, true);
});

test("Given cache-hit optimism or an insufficient reserve, when economics run, then it is blocked", () => {
  const cacheFixture = readyFixture();
  cacheFixture.economics.cacheHitRateAssumption = 0.9;
  assert.equal(evaluateGates(cacheFixture, now).ready, false);

  const reserveFixture = readyFixture();
  reserveFixture.economics.failureReserveUsd = 0.0009;
  assert.equal(evaluateGates(reserveFixture, now).ready, false);
});

test("Given retry cost consumes contribution, when economics run, then it is blocked", () => {
  const result = evaluateGates(readyFixture(approvedSource({ costPerAttemptUsd: 0.007 })), now);
  assert.equal(result.ready, false);
  assert.ok(result.economics.netContributionUsd < 0.005);
});

test("Given an incomplete payment tuple or mixed A2A quote, when gates run, then it is blocked", () => {
  const assetFixture = readyFixture();
  assetFixture.payment.tuple.contract = "0x0";
  assert.equal(evaluateGates(assetFixture, now).ready, false);

  const symbolFixture = readyFixture();
  symbolFixture.payment.tuple.symbol = "";
  assert.equal(evaluateGates(symbolFixture, now).ready, false);

  const quoteFixture = readyFixture();
  quoteFixture.payment.a2aQuote.mode = "included-in-api-price";
  assert.equal(evaluateGates(quoteFixture, now).ready, false);
});
