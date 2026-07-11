import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { REGISTRATION_STEPS } from "../scripts/verify-readiness.js";

const workspace = new URL("../", import.meta.url);

test("Given the readiness CLI When every level runs Then output and exit codes are machine-readable", () => {
  // Given
  const levels = ["local", "data", "payment", "economics", "deploy", "register", "a2a-live"];

  // When
  const runs = levels.map((level) => spawnSync(process.execPath, ["scripts/verify-readiness.js", "--level", level], {
    cwd: workspace,
    env: { ...process.env, NO_NETWORK: "1" },
    encoding: "utf8",
  }));

  // Then
  runs.forEach((run, index) => {
    const result = JSON.parse(run.stdout);
    assert.equal(result.level, levels[index]);
    assert.equal(run.status, levels[index] === "local" ? 0 : 2);
    assert.equal(result.status, levels[index] === "local" ? "ready" : "blocked-external");
  });
});

test("Given the registration runbook When inspected Then the authorized sequence is complete and ordered", async () => {
  // Given
  const runbook = await readFile(new URL("docs/registration-runbook.md", workspace), "utf8");

  // When
  const positions = REGISTRATION_STEPS.map((step) => runbook.indexOf(step));

  // Then
  assert(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.match(runbook, /本轮不执行/);
});
