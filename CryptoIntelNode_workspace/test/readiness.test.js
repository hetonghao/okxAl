import assert from "node:assert/strict";
import test from "node:test";

import { LEVELS, evaluateReadiness } from "../scripts/verify-readiness.js";

test("Given the checked-in workspace When local readiness is evaluated Then it is ready without network", async () => {
  // Given
  const environment = { ...process.env, NO_NETWORK: "1" };

  // When
  const result = await evaluateReadiness("local", { environment });

  // Then
  assert.deepEqual(result, { level: "local", status: "ready", ready: true, blockers: [] });
});

test("Given no live evidence When external readiness is evaluated Then every level is blocked-external", async () => {
  // Given
  const externalLevels = LEVELS.filter((level) => level !== "local");

  // When
  const results = await Promise.all(externalLevels.map((level) => evaluateReadiness(level)));

  // Then
  for (const result of results) {
    assert.equal(result.status, "blocked-external");
    assert.equal(result.ready, false);
    assert(result.blockers.length > 0);
    assert(result.blockers.every(({ code, reason }) => code && reason));
  }
});

test("Given synthetic success claims When live readiness is evaluated Then skip-like evidence is rejected", async () => {
  // Given
  const claims = {
    http402: "live",
    health: "live",
    testnet: "live",
    activate: "live",
    deliver: "live",
  };

  // When
  const results = await Promise.all(LEVELS.slice(1).map((level) => evaluateReadiness(level, { claims })));

  // Then
  for (const result of results) {
    assert.equal(result.status, "blocked-external");
    assert.equal(result.ready, false);
  }
});
