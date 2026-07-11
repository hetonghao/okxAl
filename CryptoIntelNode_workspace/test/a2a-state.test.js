import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createA2AState, digestPayload } from "../a2a/state.js";

const JOB = `0x${"ab".repeat(32)}`;
const identity = { agentId: "agent-7", serviceId: "service-9" };

async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-state-"));
  t.after(async () => { await rm(stateDir, { recursive: true, force: true }); });
  return createA2AState({ stateDir, ...options });
}

test("Given 合法任务 When durable accept Then 文件完整且重复写幂等", async (t) => {
  const state = await fixture(t);
  const request = { network: "eip155:1", address: `0x${"12".repeat(20)}` };

  await state.accept({ jobId: JOB, request, accepted: { event: "job_accepted" }, ...identity });
  await state.accept({ jobId: JOB, request, accepted: { event: "job_accepted" }, ...identity });

  const file = JSON.parse(await readFile(join(state.root, "jobs", JOB, "accepted.json"), "utf8"));
  assert.equal(file.schemaVersion, 1);
  assert.equal(file.digest, digestPayload({ event: "job_accepted" }));
  assert.deepEqual(file.payload, { event: "job_accepted" });
});

test("Given 已存在任务 When 同文件写入不同 payload Then 拒绝 digest 冲突", async (t) => {
  const state = await fixture(t);
  await state.accept({ jobId: JOB, request: { value: 1 }, accepted: { event: "job_accepted" }, ...identity });

  await assert.rejects(
    state.record(JOB, "accepted", { event: "changed" }, identity),
    /digest conflict/,
  );
});

test("Given submitted 终态 When 同 digest accepted 重放 Then 不重建 ready 且 worker clean no-op", async (t) => {
  const state = await fixture(t);
  const input = { jobId: JOB, request: { value: 1 }, accepted: { event: "job_accepted" }, ...identity };
  await state.accept(input);
  await state.claimNext("worker-a");
  await state.record(JOB, "submitted", { ok: true }, identity);
  await state.accept(input);
  assert.equal(await state.claimNext("worker-b"), null);
  await assert.rejects(state.record(JOB, "accepted", { event: "changed" }, identity), /digest conflict/);
});

test("Given 非法 jobId When 接收 Then 路径穿越与非 bytes32 均拒绝", async (t) => {
  const state = await fixture(t);
  for (const jobId of ["../escape", "0x12", `0x${"gg".repeat(32)}`]) {
    await assert.rejects(state.accept({ jobId, request: {}, accepted: {}, ...identity }), /jobId/);
  }
});

test("Given 非规范动态 state When 写入 Then 路径分隔符与非法 message 后缀均拒绝", async (t) => {
  const state = await fixture(t);
  await state.accept({ jobId: JOB, request: {}, accepted: {}, ...identity });

  for (const name of ["message-../../escape", "message-ABC", "message-a", "unknown/state"]) {
    await assert.rejects(state.record(JOB, name, {}, identity), /unknown state/);
  }
});

test("Given 超过 64KiB 入站内容 When 接收 Then fail closed", async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    state.accept({ jobId: JOB, request: { content: "x".repeat(65_537) }, accepted: {}, ...identity }),
    /64KiB/,
  );
});

test("Given accepted 超过 64KiB When 接收 Then 整个入站内容 fail closed", async (t) => {
  const state = await fixture(t);

  await assert.rejects(
    state.accept({ jobId: JOB, request: {}, accepted: { content: "x".repeat(70 * 1024) }, ...identity }),
    /64KiB/,
  );
});

test("Given 完整 accept 对象超过 64KiB When 接收 Then fail closed", async (t) => {
  const state = await fixture(t);
  const input = { jobId: JOB, request: {}, accepted: {}, padding: "x".repeat(65_537), ...identity };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 65_536);

  await assert.rejects(state.accept(input), /64KiB/);
});

test("Given accepted 已持久化 When 进程重建状态对象 Then 任务仍可读取", async (t) => {
  const state = await fixture(t);
  await state.accept({ jobId: JOB, request: { value: 1 }, accepted: { event: "job_accepted" }, ...identity });

  const restarted = createA2AState({ stateDir: state.stateDir });

  assert.deepEqual((await restarted.read(JOB, "accepted")).payload, { event: "job_accepted" });
});

test("Given deliverable 与 message When 重复持久化 Then 内容不可变且 dedupe 幂等", async (t) => {
  const state = await fixture(t);
  await state.accept({ jobId: JOB, request: {}, accepted: {}, ...identity });

  await state.writeDeliverable(JOB, "# report\n", identity);
  await state.recordMessage(JOB, "message-1", { content: "hello" }, identity);
  await state.recordMessage(JOB, "message-1", { content: "hello" }, identity);

  assert.equal(await readFile(join(state.root, "jobs", JOB, "deliverable.md"), "utf8"), "# report\n");
  await assert.rejects(state.writeDeliverable(JOB, "changed", identity), /digest conflict/);
});

test("Given job 已锚定 identity When 后续状态换 agent 或 service Then 拒绝", async (t) => {
  const state = await fixture(t);
  await state.accept({ jobId: JOB, request: {}, accepted: {}, ...identity });

  await assert.rejects(
    state.record(JOB, "submitted", {}, { agentId: "other-agent", serviceId: identity.serviceId }),
    /identity conflict/,
  );
  await assert.rejects(
    state.record(JOB, "submitted", {}, { agentId: identity.agentId, serviceId: "other-service" }),
    /identity conflict/,
  );
});
