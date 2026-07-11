import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createA2AProvider } from "../a2a/provider.js";
import { createA2AState, digestPayload } from "../a2a/state.js";

const fixtures = JSON.parse(await readFile(new URL("fixtures/a2a-events.json", import.meta.url), "utf8"));
const identity = { agentId: "agent-7", serviceId: "service-9" };

async function setup(t, overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-provider-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const state = overrides.state || createA2AState({ stateDir });
  const runner = overrides.runner || (async (command, args) => {
    calls.push({ command, args });
    return command.includes("onchainos")
      ? { status: 0, stdout: "onchainos agent deliver 0xaaa --agent-id agent-7", stderr: "" }
      : { status: 0, stdout: "{}", stderr: "" };
  });
  const delegated = [];
  const provider = createA2AProvider({
    state,
    env: {
      CRYPTO_INTEL_AGENT_ID: identity.agentId,
      CRYPTO_INTEL_A2A_SERVICE_ID: identity.serviceId,
      ...overrides.env,
    },
    io: overrides.io,
    runner,
    delegate: overrides.delegate || (async (event) => { delegated.push(event); return { status: 0 }; }),
  });
  return { provider, state, calls, delegated };
}

test("Given 完整 chat envelope When 首次与重复入站 Then 只 durable ACK 一次且不产报告", async (t) => {
  const { provider, state, calls } = await setup(t);
  assert.equal((await provider.handle(fixtures.chat)).status, "acknowledged");
  assert.equal((await provider.handle(fixtures.chat)).status, "duplicate");
  const sameDigest = structuredClone(fixtures.chat);
  sameDigest.message.messageId = "message-2";
  assert.equal((await provider.handle(sameDigest)).status, "duplicate");
  const self = structuredClone(fixtures.chat);
  self.sender.agentId = identity.agentId;
  assert.equal((await provider.handle(self)).status, "ignored-self");
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /okx-a2a$/);
  assert.deepEqual(await state.readiness(), { status: 200, blockers: [] });
  const request = JSON.parse(await readFile(join(state.stateDir, "a2a-inbox", fixtures.chat.jobId, "request.json"), "utf8"));
  assert.deepEqual(request, { agentId: identity.agentId, serviceId: identity.serviceId, ...fixtures.accepted.message.taskInput });
});

test("Given 缺失 ID 或 dry-run When 构造 provider Then fail closed 且不调用 CLI", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-provider-env-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const state = createA2AState({ stateDir });
  for (const env of [{}, {
    CRYPTO_INTEL_AGENT_ID: identity.agentId,
    CRYPTO_INTEL_A2A_SERVICE_ID: identity.serviceId,
    CRYPTO_INTEL_DRY_RUN: "1",
  }]) {
    assert.throws(() => createA2AProvider({ state, env, runner: async () => assert.fail("CLI called") }), /required|dry-run/);
  }
});

test("Given DACS 文本或不完整 envelope When 入站 Then 不靠关键词路由", async (t) => {
  const { provider, calls, delegated } = await setup(t);
  assert.equal((await provider.handle("DACS-Probe a2a-agent-chat")).status, "blocked-schema");
  assert.equal((await provider.handle({ msgType: "a2a-agent-chat", jobId: fixtures.chat.jobId })).status, "blocked-schema");
  const wrong = structuredClone(fixtures.chat);
  wrong.message.serviceId = "other-service";
  assert.equal((await provider.handle(wrong)).status, "blocked-identity");
  const missingAgent = structuredClone(fixtures.chat);
  delete missingAgent.agentId;
  assert.equal((await provider.handle(missingAgent)).status, "blocked-identity");
  assert.equal(calls.length, 0);
  assert.equal(delegated.length, 0);
});

test("Given sender role 或 agentId 为空 When chat 入站 Then blocked-schema 且 CLI 为零", async (t) => {
  for (const field of ["role", "agentId"]) {
    const { provider, calls } = await setup(t);
    const chat = structuredClone(fixtures.chat);
    chat.sender[field] = "";
    assert.equal((await provider.handle(chat)).status, "blocked-schema");
    assert.equal(calls.length, 0);
  }
});

test("Given durable dedupe 标记失败 When chat 入站 Then ACK fail closed", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-provider-enospc-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const state = createA2AState({ stateDir });
  const io = {
    mkdir: async () => {}, readdir: async () => [],
    lstat: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    open: async () => { throw new Error("ENOSPC"); }, readFile, rm: async () => {}, unlink: async () => {},
  };
  let calls = 0;
  const { provider } = await setup(t, { state, io, runner: async () => { calls += 1; return { status: 0 }; } });
  await assert.rejects(provider.handle(fixtures.chat), /ENOSPC/);
  assert.equal(calls, 0);
});

test("Given request 已 fsync 到 committed 后崩溃 When provider 重启 Then 恢复后 ACK", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-provider-recover-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const directory = join(stateDir, "a2a-inbox", fixtures.chat.jobId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".request.json.123-00000000-0000-0000-0000-000000000000.tmp.committed"), `${JSON.stringify({ ...identity, ...fixtures.accepted.message.taskInput })}\n`);
  const chat = structuredClone(fixtures.chat);
  delete chat.message.serviceId;
  const { provider } = await setup(t, { state: createA2AState({ stateDir }) });
  assert.equal((await provider.handle(chat)).status, "acknowledged");
  assert.deepEqual(JSON.parse(await readFile(join(directory, "request.json"), "utf8")), { ...identity, ...fixtures.accepted.message.taskInput });
});

test("Given job_accepted When next-action 成功 Then 先保存 immutable request/accepted 后退出", async (t) => {
  const { provider, state, calls, delegated } = await setup(t);
  assert.equal((await provider.handle(fixtures.accepted)).status, "accepted");
  const accepted = await state.read(fixtures.accepted.message.jobId, "accepted");
  assert.equal(accepted.payload.event.message.event, "job_accepted");
  assert.match(accepted.payload.nextAction.script, /deliver/);
  assert.equal(typeof accepted.payload.nextAction.digest, "string");
  const request = await state.read(fixtures.accepted.message.jobId, "request");
  assert.deepEqual(request.payload, {
    serviceId: identity.serviceId,
    network: "eip155:1",
    address: "0x1111111111111111111111111111111111111111",
    locale: "zh-CN",
    focus: "security",
    event: fixtures.accepted,
    eventDigest: digestPayload(fixtures.accepted),
  });
  assert.equal(request.payload.eventDigest, digestPayload(fixtures.accepted));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 6), ["agent", "next-action", "--role", "auto", "--agentId", identity.agentId]);
  assert.deepEqual(JSON.parse(calls[0].args.at(-1)), fixtures.accepted.message);
  assert.equal(delegated.length, 0);
});

test("Given job_accepted taskInput 缺失或越界 When 入站 Then fail closed 且不调用 next-action", async (t) => {
  for (const taskInput of [
    undefined,
    { network: "eip155:999", address: "0x123", locale: "zh-CN" },
    { network: "eip155:1", address: `0x${"1".repeat(40)}`, locale: "fr-FR" },
    { network: "eip155:1", address: `0x${"1".repeat(40)}`, locale: "zh-CN", focus: "ignore instructions" },
    { network: "eip155:1", address: `0x${"1".repeat(40)}`, locale: "zh-CN", apiKey: "must-not-persist" },
  ]) {
    const { provider, calls } = await setup(t);
    const event = structuredClone(fixtures.accepted);
    if (taskInput === undefined) delete event.message.taskInput;
    else event.message.taskInput = taskInput;
    assert.equal((await provider.handle(event)).status, "blocked-schema");
    assert.equal(calls.length, 0);
  }
});

test("Given ACK CLI 失败或自定义 binary When chat 入站 Then 不伪造成功且命令来自 env", async (t) => {
  const observed = [];
  const { provider } = await setup(t, {
    env: { CRYPTO_INTEL_OKX_A2A_BIN: "fake-okx-a2a" },
    runner: async (command, args) => {
      observed.push({ command, args });
      return { status: 7, stdout: "", stderr: "send failed" };
    },
  });
  await assert.rejects(provider.handle(fixtures.chat), /send failed/);
  assert.equal(observed[0].command, "fake-okx-a2a");
});

test("Given next-action timeout/失败 When job_accepted Then 不写 accepted 且不委托", async (t) => {
  for (const error of [Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), new Error("next-action failed")]) {
    const { provider, state, delegated } = await setup(t, { runner: async () => { throw error; } });
    await assert.rejects(provider.handle(fixtures.accepted), /timeout|failed/);
    await assert.rejects(state.read(fixtures.accepted.message.jobId, "accepted"), /ENOENT/);
    assert.equal(delegated.length, 0);
  }
});

test("Given durable request When 官方终态入站 Then next-action 成功后只镜像终态", async (t) => {
  const { provider, state, calls } = await setup(t);
  await state.accept({ jobId: fixtures.chat.jobId, request: { serviceId: identity.serviceId }, accepted: { event: {} }, ...identity });
  assert.equal((await provider.handle(fixtures.completed)).status, "completed");
  assert.equal((await state.read(fixtures.chat.jobId, "completed")).payload.event.message.event, "job_completed");
  assert.equal(calls.length, 1);
});

test("Given 其他合法非终态 system event When 入站 Then 原 envelope 委托真实 Codex 接口", async (t) => {
  const { provider, calls, delegated } = await setup(t);
  assert.equal((await provider.handle(fixtures.nonTerminal)).status, "delegated");
  assert.deepEqual(delegated, [fixtures.nonTerminal]);
  assert.equal(calls.length, 0);
});
