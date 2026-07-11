import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGates } from "../scripts/check-gates.js";
import { approvedSource, readyFixture } from "./source-policy.test.js";

const now = "2026-07-11T00:00:00.000Z";

test("Given an expired approval, when readiness runs, then it is blocked", () => {
  const result = evaluateGates(readyFixture(approvedSource({ expiresAt: "2026-07-10T23:59:59.000Z" })), now);
  assert.equal(result.ready, false);
  assert.match(result.reasons.join("\n"), /expired/);
});

test("Given malformed readiness input, when readiness runs, then it is blocked without throwing", () => {
  const result = evaluateGates({ dataSources: null, payment: [], economics: "ready" }, now);
  assert.equal(result.ready, false);
  assert.ok(result.reasons.length > 0);
});

test("Given missing approval identities or dates, when readiness runs, then it is blocked", () => {
  const fixture = readyFixture(approvedSource({ approvedBy: "", approvedAt: "", expiresAt: "" }));
  assert.equal(evaluateGates(fixture, now).ready, false);
});

test("Given placeholder approval identity, when readiness runs, then it is blocked", () => {
  const fixture = readyFixture(approvedSource({ approvedBy: "unknown" }));
  assert.equal(evaluateGates(fixture, now).ready, false);
});

test("Given an approval dated in the future, when readiness runs, then it is blocked", () => {
  const fixture = readyFixture(approvedSource({ approvedAt: "2026-07-12T00:00:00.000Z" }));
  assert.equal(evaluateGates(fixture, now).ready, false);
});
