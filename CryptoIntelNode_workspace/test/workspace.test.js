import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(workspace, "..");
const requiredScripts = ["check", "test", "test:x402", "readiness"];
const forbiddenReferences = ["3969", "1791", "/root/okxAl", "OnePunchMan_workspace"];

function validatePackage(packageJson) {
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines?.node, ">=22.14.0");
  assert.deepEqual(packageJson.dependencies, {
    "@okxweb3/x402-core": "0.1.0",
    "@okxweb3/x402-evm": "0.2.1",
    "@okxweb3/x402-express": "0.1.1",
    express: "5.2.1",
  });
  for (const script of requiredScripts) assert.equal(typeof packageJson.scripts?.[script], "string");
}

function validateIsolation(content) {
  for (const reference of forbiddenReferences) assert.equal(content.includes(reference), false);
}

test("Given the workspace files, when inspected, then the baseline contract is complete", async () => {
  const packageJson = JSON.parse(await readFile(resolve(workspace, "package.json"), "utf8"));
  const content = await Promise.all([
    "AGENTS.md",
    "README.md",
    ".gitignore",
    ".env.example",
  ].map((file) => readFile(resolve(workspace, file), "utf8")));

  validatePackage(packageJson);
  validateIsolation(content.join("\n"));
  await readFile(resolve(workspace, ".agents/skills/.gitkeep"));
});

test("Given root navigation, when inspected, then it describes the current workspaces and CodeGraph", async () => {
  const agents = await readFile(resolve(root, "AGENTS.md"), "utf8");

  assert.match(agents, /CryptoIntelNode_workspace\//);
  assert.doesNotMatch(agents, /未发现 `\.codegraph\/`/);
  assert.match(agents, /已存在 `\.codegraph\/`/);
});

test("Given an invalid package fixture, when validated, then it is rejected", () => {
  assert.throws(() => validatePackage({ type: "commonjs", engines: { node: ">=20" }, scripts: {} }));
});

test("Given inherited agent identifiers, when validated, then isolation rejects them", () => {
  for (const reference of forbiddenReferences) {
    assert.throws(() => validateIsolation(`config=${reference}`));
  }
});
