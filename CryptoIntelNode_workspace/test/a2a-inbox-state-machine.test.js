import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createA2AInbox } from "../a2a/inbox.js";
import { createA2AProvider } from "../a2a/provider.js";
import { createA2AState } from "../a2a/state.js";

const identity = { agentId: "agent-7", serviceId: "service-9" };
const input = { network: "eip155:1", address: `0x${"1".repeat(40)}`, locale: "zh-CN", focus: "security" };
const job = (index) => `0x${index.toString(16).padStart(64, "0")}`;
const request = { ...identity, ...input };

async function temporaryState(t, prefix) {
  const stateDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test("Given 1000 unique concurrent jobs When claimed Then exactly 100 are admitted", async (t) => {
  const stateDir = await temporaryState(t, "a2a-inbox-pressure-");
  const inboxes = Array.from({ length: 20 }, () => createA2AInbox({ stateDir }));
  const results = await Promise.all(Array.from({ length: 1000 }, (_, index) =>
    inboxes[index % inboxes.length].claim(job(index), request, `sender-${index}`, `digest-${index}`)));
  assert.equal(results.filter(({ status }) => status === "claimed").length, 100);
  assert.equal(results.filter(({ status }) => status === "blocked-capacity").length, 900);
});

test("Given 100 stale unaccepted jobs When TTL passes Then capacity is reclaimed", async (t) => {
  const stateDir = await temporaryState(t, "a2a-inbox-stale-");
  let time = 1_000;
  const inbox = createA2AInbox({ stateDir, now: () => time, staleMs: 10_000 });
  const initial = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    inbox.claim(job(index), request, `sender-${index}`, `digest-${index}`)));
  assert.equal(initial.filter(({ status }) => status === "claimed").length, 100);
  time += 10_001;
  assert.equal((await inbox.claim(job(1001), request, "fresh-sender", "fresh-digest")).status, "claimed");
});

test("Given one sender floods inbox When quota reached Then other senders retain capacity", async (t) => {
  const stateDir = await temporaryState(t, "a2a-inbox-quota-");
  const inbox = createA2AInbox({ stateDir });
  const flood = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    inbox.claim(job(index), request, "noisy-sender", `digest-${index}`)));
  assert.equal(flood.filter(({ status }) => status === "claimed").length, 10);
  assert.equal(flood.filter(({ status }) => status === "blocked-sender-capacity").length, 90);
  assert.equal((await inbox.claim(job(1000), request, "quiet-sender", "quiet-digest")).status, "claimed");
});

test("Given ACK first attempt fails When same chat retries concurrently Then one retry ACKs once", async (t) => {
  const stateDir = await temporaryState(t, "a2a-inbox-ack-retry-");
  let attempts = 0;
  let releaseRetry;
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  const runner = async () => {
    attempts += 1;
    if (attempts === 1) return { status: 7, stdout: "", stderr: "send failed" };
    await retryGate;
    return { status: 0, stdout: "{}", stderr: "" };
  };
  const state = createA2AState({ stateDir });
  const provider = createA2AProvider({
    state,
    env: { CRYPTO_INTEL_AGENT_ID: identity.agentId, CRYPTO_INTEL_A2A_SERVICE_ID: identity.serviceId },
    runner,
  });
  const chat = {
    msgType: "a2a-agent-chat", agentId: identity.agentId, jobId: job(77),
    sender: { role: "user", agentId: "buyer-1" },
    message: { serviceId: identity.serviceId, messageId: "message-1", content: JSON.stringify(input) },
  };
  await assert.rejects(provider.handle(chat), /send failed/);
  const retries = Array.from({ length: 20 }, () => provider.handle(structuredClone(chat)));
  await new Promise((resolve) => setImmediate(resolve));
  releaseRetry();
  const results = await Promise.all(retries);
  assert.equal(attempts, 2);
  assert.equal(results.filter(({ status }) => status === "acknowledged").length, 1);
  assert.equal(results.filter(({ status }) => status === "duplicate" || status === "ack-in-progress").length, 19);
  assert.equal((await provider.handle(chat)).status, "duplicate");
});

test("Given process crashes while holding ACK lease When lease is stale Then restart can recover", async (t) => {
  const stateDir = await temporaryState(t, "a2a-inbox-ack-crash-");
  const inbox = createA2AInbox({ stateDir });
  assert.equal((await inbox.claim(job(88), request, "buyer-1", "digest-88")).status, "claimed");
  assert.equal(await inbox.beginAck(job(88)), true);
  const stale = new Date(Date.now() - 31_000);
  await utimes(join(stateDir, "a2a-inbox", job(88), ".ack-lock"), stale, stale);
  const restarted = createA2AInbox({ stateDir });
  assert.equal(await restarted.beginAck(job(88)), true);
  await restarted.finishAck(job(88), true);
  assert.equal((await restarted.claim(job(88), request, "buyer-1", "digest-88")).status, "duplicate");
});
