import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createA2AProvider } from "../a2a/provider.js";
import { createA2AState } from "../a2a/state.js";

const fixtures = JSON.parse(await readFile(new URL("fixtures/a2a-events.json", import.meta.url), "utf8"));
const identity = { agentId: "agent-7", serviceId: "service-9" };

async function setup(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-inbox-security-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const state = createA2AState({ stateDir });
  const provider = createA2AProvider({
    state,
    env: { CRYPTO_INTEL_AGENT_ID: identity.agentId, CRYPTO_INTEL_A2A_SERVICE_ID: identity.serviceId },
    runner: async (command, args) => {
      calls.push({ command, args });
      return command.includes("onchainos")
        ? { status: 0, stdout: "onchainos agent deliver", stderr: "" }
        : { status: 0, stdout: "{}", stderr: "" };
    },
  });
  return { provider, state, stateDir, calls };
}

test("同一 job/sender 的不同消息 ID 与等价 JSON 只持久化并 ACK 一次", async (t) => {
  const { provider, stateDir, calls } = await setup(t);
  for (let index = 0; index < 200; index += 1) {
    const chat = structuredClone(fixtures.chat);
    chat.message.messageId = `attacker-${index}`;
    chat.message.content = index % 2
      ? '{ "focus":"security", "locale":"zh-CN", "address":"0x1111111111111111111111111111111111111111", "network":"eip155:1" }'
      : JSON.stringify(fixtures.accepted.message.taskInput);
    const result = await provider.handle(chat);
    assert.equal(result.status, index === 0 ? "acknowledged" : "duplicate");
  }
  assert.equal(calls.length, 1);
  assert.deepEqual((await readdir(join(stateDir, "a2a-inbox", fixtures.chat.jobId))).sort(), ["acknowledged.json", "message.json", "request.json"]);
});

test("超大 sender/content 在持久化与 ACK 前被拒绝", async (t) => {
  for (const mutate of [
    (chat) => { chat.sender.agentId = "x".repeat(257); },
    (chat) => { chat.message.content = `${JSON.stringify(fixtures.accepted.message.taskInput)}${" ".repeat(64 * 1024)}`; },
  ]) {
    const { provider, calls } = await setup(t);
    const chat = structuredClone(fixtures.chat);
    mutate(chat);
    assert.equal((await provider.handle(chat)).status, "blocked-schema");
    assert.equal(calls.length, 0);
  }
});

test("inbox 最多接纳 100 个 job 且第 101 个不启动 ACK", async (t) => {
  const { provider, stateDir, calls } = await setup(t);
  for (let index = 0; index < 101; index += 1) {
    const chat = structuredClone(fixtures.chat);
    chat.jobId = `0x${index.toString(16).padStart(64, "0")}`;
    chat.sender.agentId = `sender-${index}`;
    const result = await provider.handle(chat);
    assert.equal(result.status, index < 100 ? "acknowledged" : "blocked-capacity");
  }
  assert.equal(calls.length, 100);
  assert.equal((await readdir(join(stateDir, "a2a-inbox"))).length, 100);
});

test("accepted 后清理 inbox，迟到 chat 不重建 marker 或重复 ACK", async (t) => {
  const { provider, stateDir, calls } = await setup(t);
  assert.equal((await provider.handle(fixtures.chat)).status, "acknowledged");
  assert.equal((await provider.handle(fixtures.accepted)).status, "accepted");
  await assert.rejects(access(join(stateDir, "a2a-inbox", fixtures.chat.jobId)), /ENOENT/);
  assert.equal((await provider.handle(fixtures.chat)).status, "duplicate");
  assert.equal(calls.filter(({ command }) => command.endsWith("okx-a2a")).length, 1);
});
