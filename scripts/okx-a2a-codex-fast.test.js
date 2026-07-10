#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const script = path.join(__dirname, "okx-a2a-codex-fast.js");
const jobId = "0x992ff1e8844f7bd87f35b70a8561b06088b1e93bb4d756d2f4c9ad07a89e7d1b";

function run(senderAgentId) {
  return spawnSync(process.execPath, [script, JSON.stringify({
    msgType: "a2a-agent-chat",
    jobId,
    sender: { agentId: senderAgentId, role: 1 },
    content: "DACS-Probe",
  })], {
    encoding: "utf8",
    env: {
      ...process.env,
      OKX_A2A_FAST_DRY_RUN: "1",
      OKX_A2A_REAL_CODEX: "/bin/false",
    },
  });
}

const external = run("1791");
assert.equal(external.status, 0, external.stderr);
assert.match(external.stdout, /okx-a2a xmtp-send/);
assert.doesNotMatch(external.stdout, /okx-a2a session send/);
assert.match(external.stdout, new RegExp(`fast-${jobId.slice(2)}`));

const self = run("3969");
assert.equal(self.status, 0, self.stderr);
assert.match(self.stdout, /已忽略本 Agent 自己发出的 XMTP 消息/);
assert.doesNotMatch(self.stdout, /okx-a2a xmtp-send/);

console.log("okx-a2a fast path checks passed");
