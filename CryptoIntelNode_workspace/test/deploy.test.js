import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "deploy/runtime.env.example",
  "deploy/systemd/crypto-intel-api.service",
  "deploy/systemd/crypto-intel-a2a-worker.service",
  "deploy/systemd/crypto-intel-a2a-worker.path",
  "deploy/systemd/okx-a2a.service.d/20-crypto-intel-provider.conf.example",
  "deploy/nginx/crypto-intel-node.conf",
  "docs/deployment-runbook.md",
  "test/deploy.test.js",
];
const names = {
  env: files[0], api: files[1], worker: files[2], path: files[3],
  dropIn: files[4], nginx: files[5], runbook: files[6], test: files[7],
};
const forbidden = [
  "39" + "69", "17" + "91", ["134", "175", "246", "38"].join("."),
  "/root/" + "okxAl", "One" + "PunchMan",
];

function validate(content) {
  assert.deepEqual(Object.keys(content).sort(), files.toSorted());
  const corpus = Object.values(content).join("\n");
  for (const value of forbidden) assert.equal(corpus.includes(value), false, `forbidden deployment reuse: ${value}`);

  assert.match(content[names.env], /^PORT=8787$/m);
  assert.match(content[names.env], /^CRYPTO_INTEL_STATE_DIR=\/home\/crypto-intel\/\.local\/state\/crypto-intel-node$/m);
  assert.match(content[names.env], /^CRYPTO_INTEL_AGENT_ID=$/m);
  assert.match(content[names.env], /^CRYPTO_INTEL_A2A_SERVICE_ID=$/m);
  for (const line of content[names.env].split("\n")) {
    if (/^(?:[A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|PRIVATE)[A-Z0-9_]*)=.+/.test(line)) {
      assert.fail("runtime env example contains a non-empty secret");
    }
  }

  const units = [content[names.api], content[names.worker]];
  for (const unit of units) {
    assert.match(unit, /^User=crypto-intel$/m);
    assert.match(unit, /^WorkingDirectory=\/opt\/crypto-intel-node\/current$/m);
    assert.match(unit, /^EnvironmentFile=\/home\/crypto-intel\/\.config\/crypto-intel-node\/runtime\.env$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
  }
  assert.match(content[names.api], /^ExecStart=.*node .*scripts\/start-api\.js$/m);
  assert.doesNotMatch(content[names.api], /src\/server\.js/);
  assert.doesNotMatch(content[names.api], /(?:cluster|pm2|instances|workers?)\s*[=:]\s*(?:[2-9]|unlimited)/i);
  assert.match(content[names.worker], /^Environment=A2A_WORKER_CONCURRENCY=1$/m);
  assert.match(content[names.worker], /^ExecStart=.*node .*scripts\/run-a2a-worker\.js$/m);
  assert.doesNotMatch(content[names.worker], /a2a\/worker\.js/);
  assert.match(content[names.path], /^PathExistsGlob=\/home\/crypto-intel\/\.local\/state\/crypto-intel-node\/a2a\/jobs\/\*\/ready$/m);
  assert.match(content[names.path], /^Unit=crypto-intel-a2a-worker\.service$/m);

  assert.match(names.dropIn, /\.example$/);
  assert.doesNotMatch(content[names.dropIn], /(?:enabled|active|deployed|live[- ]completed)\s*[:=]\s*(?:true|yes|done)/i);
  assert.match(content[names.nginx], /listen\s+443\s+ssl/);
  assert.match(content[names.nginx], /proxy_pass\s+http:\/\/127\.0\.0\.1:8787/);
  assert.doesNotMatch(content[names.nginx], /(?:a2a|worker).*listen|listen.*(?:a2a|worker)/i);
  const host = content[names.nginx].match(/server_name\s+([^;]+);/)?.[1];
  assert.ok(host && /(?:PUBLIC_HOSTNAME|<[^>]+>|__[A-Z_]+__)/.test(host), "Nginx must keep the hostname parameterized");

  const runbook = content[names.runbook];
  for (const gate of ["local-ready", "deploy-ready", "register-ready", "live-completed", "blocked-linux"]) assert.match(runbook, new RegExp(gate));
  for (const command of ["DNS", "TLS", "systemctl", "nginx", "daemon status", "agent refresh", "setup", "status"]) assert.match(runbook, new RegExp(command, "i"));
  assert.match(runbook, /install\b[^\n]*-m\s+0600[^\n]*runtime\.env/);
  const installAt = runbook.search(/^## install/im);
  const healthAt = runbook.search(/^## health/im);
  const rollbackAt = runbook.search(/^## rollback/im);
  assert.ok(installAt >= 0 && installAt < healthAt && healthAt < rollbackAt);
  const rollback = runbook.slice(rollbackAt);
  assert.match(rollback, /current/);
  assert.doesNotMatch(rollback, /rm\s+-rf?.*(?:\.local\/state|\.config\/crypto-intel-node|runtime\.env|deliverable)/);
}

const valid = {
  [names.env]: "PORT=8787\nCRYPTO_INTEL_STATE_DIR=/home/crypto-intel/.local/state/crypto-intel-node\nCRYPTO_INTEL_AGENT_ID=\nCRYPTO_INTEL_A2A_SERVICE_ID=\nOPENAI_API_KEY=\n",
  [names.api]: "[Service]\nUser=crypto-intel\nWorkingDirectory=/opt/crypto-intel-node/current\nEnvironmentFile=/home/crypto-intel/.config/crypto-intel-node/runtime.env\nExecStart=/usr/bin/node /opt/crypto-intel-node/current/scripts/start-api.js\nRestart=on-failure\nNoNewPrivileges=true\nProtectSystem=strict\n",
  [names.worker]: "[Service]\nUser=crypto-intel\nWorkingDirectory=/opt/crypto-intel-node/current\nEnvironmentFile=/home/crypto-intel/.config/crypto-intel-node/runtime.env\nEnvironment=A2A_WORKER_CONCURRENCY=1\nExecStart=/usr/bin/node /opt/crypto-intel-node/current/scripts/run-a2a-worker.js\nRestart=on-failure\nNoNewPrivileges=true\nProtectSystem=strict\n",
  [names.path]: "[Path]\nPathExistsGlob=/home/crypto-intel/.local/state/crypto-intel-node/a2a/jobs/*/ready\nUnit=crypto-intel-a2a-worker.service\n",
  [names.dropIn]: "# provider binding remains externally blocked\n",
  [names.nginx]: "server { listen 443 ssl; server_name __PUBLIC_HOSTNAME__; location / { proxy_pass http://127.0.0.1:8787; } }\n",
  [names.runbook]: "local-ready blocked-linux\ndeploy-ready\nregister-ready\nlive-completed\nDNS TLS systemctl nginx daemon status agent refresh setup status\ninstall -m 0600 deploy/runtime.env.example /home/crypto-intel/.config/crypto-intel-node/runtime.env\nhealth\nrollback: ln -sfn previous /opt/crypto-intel-node/current\n",
  [names.test]: "stdlib test marker",
};

function approvedGates() {
  const approval = { status: "approved", approvedBy: "fixture@example.invalid", approvedAt: "2026-07-10T00:00:00Z", expiresAt: "2026-08-10T00:00:00Z" };
  return {
    "data-sources.json": { policyVersion: "1", sources: [{
      id: "synthetic", endpoint: "https://source.example.invalid", plan: "server", docsUrl: "https://docs.example.invalid",
      termsUrl: "https://terms.example.invalid", reviewedAt: "2026-07-10", attribution: "required", commercialServerUse: "yes",
      derivativePaidOutput: "yes", cache: "yes", realFixtureRetention: "yes", rateLimitPerMinute: 1,
      costPerAttemptUsd: 0.001, chains: ["eip155:1"], ...approval,
    }] },
    "payment.json": {
      listingFee: "0.02", runtimePrice: "$0.02", settlementCostUsd: 0.001, ...approval,
      tuple: { network: "eip155:1", contract: `0x${"1".repeat(40)}`, decimals: 6, amountAtomic: "20000", payTo: `0x${"2".repeat(40)}`, symbol: "SYNTH" },
      a2aQuote: { mode: "separate" },
    },
    "unit-economics.json": {
      maxSourceAttempts: 2, marginalInfraCostUsd: 0.001, failureReserveUsd: 0.001,
      minimumFailureReserveRate: 0.05, minimumNetContributionUsd: 0.005, cacheHitRateAssumption: 0, ...approval,
    },
  };
}

test("deployment artifacts satisfy the local contract", async () => {
  const content = {};
  for (const file of files) {
    content[file] = await readFile(resolve(workspace, file), "utf8");
  }
  validate(content);

  const entries = ["scripts/start-api.js", "scripts/run-a2a-worker.js"];
  for (const entry of entries) {
    await readFile(resolve(workspace, entry));
    assert.equal(spawnSync(process.execPath, ["--check", resolve(workspace, entry)]).status, 0, `${entry} must parse`);
  }
  const worker = spawnSync(process.execPath, [resolve(workspace, entries[1])], {
    cwd: workspace,
    env: { PATH: process.env.PATH, NO_NETWORK: "1" },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.notEqual(worker.status, 0, "worker must fail closed without identity and data readiness");
  assert.match(`${worker.stdout}\n${worker.stderr}`, /blocked/i);

  const { runA2AWorker } = await import(pathToFileURL(resolve(workspace, entries[1])));
  assert.equal(typeof runA2AWorker, "function", "worker entry must export an injectable composition seam");
  const gates = approvedGates();
  const observed = { runs: 0 };
  const state = { fixture: true };
  await runA2AWorker({
    env: {
      NO_NETWORK: "1",
      CRYPTO_INTEL_STATE_DIR: "/tmp/crypto-intel-fixture",
      CRYPTO_INTEL_AGENT_ID: "agent-fixture",
      CRYPTO_INTEL_A2A_SERVICE_ID: "service-fixture",
    },
    readReadiness: async (name) => structuredClone(gates[name]),
    createState(options) { observed.stateOptions = options; return state; },
    adapterRegistryFactory: async () => ({ synthetic: async () => null }),
    createWorker(options) {
      observed.workerOptions = options;
      return { async runOnce() { observed.runs += 1; } };
    },
  });
  assert.deepEqual(observed.stateOptions, { stateDir: "/tmp/crypto-intel-fixture" });
  assert.equal(observed.workerOptions.state, state);
  assert.deepEqual(observed.workerOptions.identity, { agentId: "agent-fixture", serviceId: "service-fixture" });
  assert.equal(observed.runs, 1);
});

test("runtime env installs with mode 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crypto-intel-env-"));
  const target = join(directory, "runtime.env");
  try {
    await copyFile(resolve(workspace, names.env), target);
    await chmod(target, 0o600);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validator rejects deployment contract regressions", async (t) => {
  const cases = [
    ["missing working directory", names.api, (s) => s.replace("WorkingDirectory=", "Directory=")],
    ["unsafe env mode", names.runbook, (s) => s.replace("-m 0600", "-m 0644")],
    ["public A2A listener", names.nginx, (s) => `${s}\na2a listen 8788\n`],
    ["rollback deletes durable state", names.runbook, (s) => `${s}\nrm -rf /home/crypto-intel/.local/state\n`],
    ["inherited identity and ports", names.api, (s) => `${s}\n# ${forbidden[0]} ${forbidden[1]} ${forbidden[4]}\n`],
    ["inherited host paths", names.api, (s) => `${s}\n# ${forbidden[2]} ${forbidden[3]}\n`],
    ["non-example provider drop-in", names.dropIn, (s) => s, names.dropIn.replace(/\.example$/, "")],
    ["provider falsely marked enabled", names.dropIn, (s) => `${s}\nenabled=true\n`],
    ["non-empty secret", names.env, (s) => s.replace("OPENAI_API_KEY=", "OPENAI_API_KEY=fixture-secret")],
  ];
  for (const [label, file, mutate, renamed] of cases) await t.test(label, () => {
    const fixture = structuredClone(valid);
    if (renamed) { fixture[renamed] = fixture[file]; delete fixture[file]; }
    else if (file) fixture[file] = mutate(fixture[file]);
    assert.throws(() => validate(fixture));
  });
});
