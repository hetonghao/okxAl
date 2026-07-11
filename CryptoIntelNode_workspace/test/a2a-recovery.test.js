import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import { createA2AState } from "../a2a/state.js";
import { createA2AWorker } from "../a2a/worker.js";

const JOB = `0x${"c".repeat(64)}`;
const identity = { agentId: "agent-7", serviceId: "service-9" };

async function attempted(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "crypto-intel-recovery-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const state = createA2AState({ stateDir });
  await state.accept({
    jobId: JOB,
    request: { network: "eip155:1", address: `0x${"1".repeat(40)}`, locale: "zh-CN" },
    accepted: { nextAction: { script: `onchainos agent deliver ${JOB} --agent-id ${identity.agentId}` } },
    ...identity,
  });
  await state.claimNext("crypto-intel-worker");
  await state.writeDeliverable(JOB, "# durable\n", identity);
  await state.record(JOB, "delivery-attempt", { command: "deliver" }, identity);
  return state;
}

test("delivery-attempt 后重启只查 status，submitted/completed 修复且绝不重发", async (t) => {
  for (const providerStatus of ["submitted", "completed"]) {
    const state = await attempted(t);
    let deliveries = 0;
    const worker = createA2AWorker({
      state, identity,
      assess: async () => { throw new Error("must not assess"); },
      runner: async () => { deliveries += 1; },
      statusRunner: async (command, args) => {
        assert.equal(command, "onchainos");
        assert.deepEqual(args, ["agent", "status", JOB, "--agent-id", identity.agentId]);
        return { status: 0, stdout: JSON.stringify({ data: { status: providerStatus } }), stderr: "" };
      },
    });
    assert.deepEqual(await worker.runOnce(), { jobId: JOB, status: providerStatus });
    assert.equal(deliveries, 0);
    assert.equal((await state.read(JOB, providerStatus)).payload.reconciled, true);
  }
});

test("status 仍 accepted、未知、失败时写 delivery-unknown 并且绝不盲发", async (t) => {
  for (const result of [
    { status: 0, stdout: JSON.stringify({ status: "accepted" }), stderr: "" },
    { status: 0, stdout: JSON.stringify({ status: "mystery" }), stderr: "" },
    { status: 1, stdout: "", stderr: "timeout" },
  ]) {
    const state = await attempted(t);
    let deliveries = 0;
    const worker = createA2AWorker({ state, identity, runner: async () => { deliveries += 1; }, statusRunner: async () => result });
    assert.deepEqual(await worker.runOnce(), { jobId: JOB, status: "delivery-unknown" });
    assert.equal(deliveries, 0);
    assert.equal((await state.read(JOB, "delivery-unknown")).payload.reason, "ambiguous-delivery");
  }
});

test("真实子进程在 deliver 返回窗口被强杀后，重启只对账且不重发", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "crypto-intel-sigkill-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const receipt = join(stateDir, "deliver-count");
  const state = createA2AState({ stateDir });
  const request = { network: "eip155:1", address: `0x${"1".repeat(40)}`, locale: "zh-CN" };
  await state.accept({
    jobId: JOB, request,
    accepted: { nextAction: { script: `onchainos agent deliver ${JOB} --agent-id ${identity.agentId}` } },
    ...identity,
  });
  const childScript = `
    import { appendFile } from "node:fs/promises";
    import { createA2AState } from ${JSON.stringify(new URL("../a2a/state.js", import.meta.url).href)};
    import { createA2AWorker } from ${JSON.stringify(new URL("../a2a/worker.js", import.meta.url).href)};
    const state=createA2AState({stateDir:${JSON.stringify(stateDir)}});
    const assessment={scoreVersion:"risk-v1.0.0",score:71,level:"high",confidence:0.85,dimensions:{security:{score:60,status:"fresh"},liquidity:{score:75,status:"fresh"},concentration:{score:90,status:"fresh"}},evidence:[{dimension:"security",source:"a",ruleId:"security.risk-control.3",score:60,status:"fresh",observedAt:"2026-07-10T23:00:00.000Z"},{dimension:"liquidity",source:"a",ruleId:"liquidity.10k-50k",score:75,status:"fresh",observedAt:"2026-07-10T23:00:00.000Z"},{dimension:"concentration",source:"a",ruleId:"concentration.label.high",score:90,status:"fresh",observedAt:"2026-07-10T23:00:00.000Z"}],conflicts:[],missing:[]};
    const worker=createA2AWorker({state,identity:${JSON.stringify(identity)},assess:async()=>({asset:${JSON.stringify(request)},assessment}),runner:async()=>{await appendFile(${JSON.stringify(receipt)},"1\\n");process.kill(process.pid,"SIGKILL")}});
    await worker.runOnce();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
  const outcome = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(outcome.signal, "SIGKILL");

  let deliveries = 0;
  const restarted = createA2AWorker({
    state: createA2AState({ stateDir }), identity,
    runner: async () => { deliveries += 1; },
    statusRunner: async () => ({ status: 0, stdout: JSON.stringify({ status: "submitted" }), stderr: "" }),
  });
  assert.deepEqual(await restarted.runOnce(), { jobId: JOB, status: "submitted" });
  assert.equal(deliveries, 0);
  assert.equal((await (await import("node:fs/promises")).readFile(receipt, "utf8")).trim(), "1");
});
