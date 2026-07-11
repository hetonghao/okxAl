import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGates } from "../scripts/check-gates.js";
import { approvedSource, readyFixture } from "./source-policy.test.js";

const now = "2026-07-11T00:00:00.000Z";

test("Given incomplete provenance, when gates run, then every required evidence class is rejected", () => {
  const fields = ["endpoint", "plan", "docsUrl", "termsUrl", "reviewedAt", "attribution"];
  for (const field of fields) {
    assert.equal(evaluateGates(readyFixture(approvedSource({ [field]: "" })), now).ready, false, field);
  }
});

test("Given placeholder provenance, when gates run, then unknown and pending text is rejected", () => {
  for (const field of ["endpoint", "plan", "docsUrl", "termsUrl", "reviewedAt", "attribution"]) {
    assert.equal(evaluateGates(readyFixture(approvedSource({ [field]: "unknown" })), now).ready, false, field);
  }
});

test("Given unsafe real fixture retention or missing operating limits, when gates run, then it is blocked", () => {
  const invalid = [
    approvedSource({ realFixtureRetention: "unknown" }),
    approvedSource({ rateLimitPerMinute: 0 }),
    approvedSource({ costPerAttemptUsd: -1 }),
    approvedSource({ chains: [] }),
  ];
  for (const source of invalid) assert.equal(evaluateGates(readyFixture(source), now).ready, false);
});

test("Given unsupported policy answers, when gates run, then only explicit yes is accepted", () => {
  for (const field of ["commercialServerUse", "derivativePaidOutput", "cache", "realFixtureRetention"]) {
    assert.equal(evaluateGates(readyFixture(approvedSource({ [field]: "pending" })), now).ready, false, field);
  }
});
