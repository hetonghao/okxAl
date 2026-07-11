import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createA2AProvider } from "../a2a/provider.js";
import { createA2AState } from "../a2a/state.js";
import { createA2AWorker } from "../a2a/worker.js";

const events = JSON.parse(await readFile(new URL("fixtures/a2a-events.json", import.meta.url), "utf8"));

const JOB = `0x${"a".repeat(64)}`;
const identity = { agentId: "agent-7", serviceId: "service-9" };
const request = { network: "eip155:1", address: `0x${"1".repeat(40)}`, locale: "zh-CN", focus: "security" };
const assessment = {
  scoreVersion: "risk-v1.0.0", score: 71, level: "high", confidence: 0.85,
  dimensions: { security: { score: 60, status: "fresh" }, liquidity: { score: 75, status: "fresh" }, concentration: { score: 90, status: "fresh" } },
  evidence: [
    { dimension: "security", source: "alpha", ruleId: "security.risk-control.3", score: 60, status: "fresh", observedAt: "2026-07-10T23:00:00.000Z" },
    { dimension: "liquidity", source: "alpha", ruleId: "liquidity.10k-50k", score: 75, status: "fresh", observedAt: "2026-07-10T23:00:00.000Z" },
    { dimension: "concentration", source: "alpha", ruleId: "concentration.label.high", score: 90, status: "fresh", observedAt: "2026-07-10T23:00:00.000Z" },
  ],
  conflicts: [], missing: [],
};

async function fixture(t, script = `onchainos agent deliver ${JOB} --agent-id ${identity.agentId}`) {
  const stateDir = await mkdtemp(join(tmpdir(), "crypto-intel-worker-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const state = createA2AState({ stateDir });
  await state.accept({ jobId: JOB, request, accepted: { event: { message: { event: "job_accepted", jobId: JOB } }, nextAction: { script } }, ...identity });
  return state;
}

test("accepted 后才评估、生成 durable 报告并且 deliver 成功只写 submitted", async (t) => {
  const state = await fixture(t);
  const calls = { assess: 0, deliver: 0 };
  const worker = createA2AWorker({
    state, identity,
    assess: async (input) => { calls.assess += 1; assert.deepEqual(input, request); return { asset: request, assessment }; },
    runner: async (command, args) => {
      calls.deliver += 1;
      assert.equal(command, "onchainos");
      assert.deepEqual(args.slice(0, 4), ["agent", "deliver", JOB, "--agent-id"]);
      assert.equal(args[4], identity.agentId);
      assert.equal(args[5], "--file");
      assert.match(args[6], /deliverable\.md$/);
      return { status: 0, stdout: JSON.stringify({ status: "submitted" }), stderr: "" };
    },
    statusRunner: async () => { throw new Error("unused"); },
  });
  assert.deepEqual(calls, { assess: 0, deliver: 0 });
  assert.deepEqual(await worker.runOnce(), { jobId: JOB, status: "submitted" });
  assert.deepEqual(calls, { assess: 1, deliver: 1 });
  assert.match(await readFile(join(state.root, "jobs", JOB, "deliverable.md"), "utf8"), /71\/100/);
  assert.equal((await state.read(JOB, "submitted")).payload.deliveryStatus, "submitted");
  await assert.rejects(state.read(JOB, "completed"), { code: "ENOENT" });
  assert.equal(await worker.runOnce(), null);
  assert.deepEqual(calls, { assess: 1, deliver: 1 });
});

test("严格 next-action 拒绝额外命令、错 job/agent，且风险与 deliver 都不执行", async (t) => {
  for (const [index, script] of [
    `onchainos agent deliver ${JOB} --agent-id agent-7; touch /tmp/pwned`,
    `onchainos agent deliver 0x${"b".repeat(64)} --agent-id agent-7`,
    `onchainos agent deliver ${JOB} --agent-id agent-8`,
  ].entries()) {
    const stateDir = await mkdtemp(join(tmpdir(), `crypto-intel-invalid-${index}-`));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const state = createA2AState({ stateDir });
    await state.accept({ jobId: JOB, request, accepted: { nextAction: { script } }, ...identity });
    let calls = 0;
    const worker = createA2AWorker({ state, identity, assess: async () => { calls += 1; }, runner: async () => { calls += 1; } });
    await assert.rejects(worker.runOnce(), /next-action/);
    assert.equal(calls, 0);
  }
});

test("deliver 失败写 failed，两个 worker 只有一个实际执行", async (t) => {
  const state = await fixture(t);
  let deliveries = 0;
  const options = {
    state, identity,
    assess: async () => ({ asset: request, assessment }),
    runner: async () => { deliveries += 1; return { status: 1, stdout: "", stderr: "rejected" }; },
  };
  const results = await Promise.allSettled([
    createA2AWorker({ ...options, workerId: "worker-a" }).runOnce(),
    createA2AWorker({ ...options, workerId: "worker-b" }).runOnce(),
  ]);
  assert.equal(deliveries, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal((await state.read(JOB, "failed")).payload.reason, "deliver-failed");
});

test("真实 provider chat→accepted→worker→submitted→completed 全链且重复 accepted 不重做", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "crypto-intel-provider-worker-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const state = createA2AState({ stateDir });
  const providerCalls = [];
  const provider = createA2AProvider({
    state,
    env: { CRYPTO_INTEL_AGENT_ID: identity.agentId, CRYPTO_INTEL_A2A_SERVICE_ID: identity.serviceId },
    runner: async (command, args) => {
      providerCalls.push({ command, args });
      return command === "onchainos"
        ? { status: 0, stdout: `onchainos agent deliver ${JOB} --agent-id ${identity.agentId}`, stderr: "" }
        : { status: 0, stdout: "{}", stderr: "" };
    },
    delegate: async () => ({ status: 0 }),
  });
  assert.equal((await provider.handle(events.chat)).status, "acknowledged");
  const acceptedEvent = structuredClone(events.accepted);
  delete acceptedEvent.message.taskInput;
  assert.equal((await provider.handle(acceptedEvent)).status, "accepted");
  let assessments = 0;
  let deliveries = 0;
  const worker = createA2AWorker({
    state, identity,
    assess: async (input) => {
      assessments += 1;
      assert.deepEqual({ network: input.network, address: input.address, locale: input.locale, focus: input.focus }, request);
      assert.equal(input.serviceId, identity.serviceId);
      assert.equal(input.event.message.event, "job_accepted");
      assert.equal(typeof input.eventDigest, "string");
      return { asset: request, assessment };
    },
    runner: async () => { deliveries += 1; return { status: 0, stdout: JSON.stringify({ status: "submitted" }), stderr: "" }; },
  });
  assert.deepEqual(await worker.runOnce(), { jobId: JOB, status: "submitted" });
  assert.equal((await provider.handle(acceptedEvent)).status, "accepted");
  assert.equal(await worker.runOnce(), null);
  assert.deepEqual({ assessments, deliveries }, { assessments: 1, deliveries: 1 });
  assert.equal((await provider.handle(events.completed)).status, "completed");
  assert.equal((await state.read(JOB, "completed")).payload.event.message.event, "job_completed");
  assert.equal(providerCalls.filter(({ command }) => command === "onchainos").length, 2);
});
