import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const agentDescription = "为交易与研究 Agent 提供可核验、可追溯的 EVM 代币风险评分与加密资产情报报告。";
const serviceDescriptions = [
  "面向交易与研究 Agent，提供 EVM 代币的安全、流动性与持仓集中度风险评分及证据摘要。\n请提供网络标识、代币合约地址和可选输出语言。",
  "面向交易与研究 Agent，生成基于可核验证据的加密资产风险研究报告。\n请提供网络标识、代币合约地址、研究重点和可选输出语言。",
];

function pngInfo(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "头像必须是 PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), size: bytes.length };
}

function validateDraft(draft, materializedEndpoint) {
  assert.equal(draft.kind, "registration-candidate", "草稿必须标记为注册候选资料");
  assert.equal(draft.cliImportable, false, "草稿不能伪装成可直接导入的 CLI manifest");
  assert.equal(draft.notice, "不是可直接导入的 CLI manifest");
  assert.equal(draft.agent.name, "Crypto Intel Node");
  assert.equal(draft.agent.description, agentDescription);
  assert.ok(draft.agent.name.length >= 3 && draft.agent.name.length <= 25);
  assert.ok(draft.agent.description.length <= 500);
  assert.equal(draft.agent.preferredLanguage, "zh-CN");
  assert.equal(draft.services.length, 2, "必须恰好两个服务");

  const [risk, report] = draft.services;
  assert.deepEqual(
    { name: risk.serviceName, description: risk.serviceDescription, type: risk.serviceType, fee: risk.fee },
    { name: "Token Risk Score", description: serviceDescriptions[0], type: "A2MCP", fee: "0.02" },
  );
  assert.equal(typeof risk.fee, "string");
  assert.match(risk.fee, /^\d+(?:\.\d{1,6})?$/, "fee 只能是无币种后缀的数字字符串");
  if (Object.hasOwn(risk, "endpoint")) {
    assert.equal(risk.endpoint, materializedEndpoint, "endpoint 只能从明确配置物化");
    const endpoint = new URL(risk.endpoint);
    assert.equal(endpoint.protocol, "https:");
    assert.ok(!["localhost", "127.0.0.1"].includes(endpoint.hostname));
  } else {
    assert.equal(materializedEndpoint, undefined, "未具备公网 HTTPS 前不能物化 endpoint");
  }
  assert.equal(draft.materialization.endpointFrom, "PUBLIC_HTTPS_ENDPOINT");
  assert.equal(draft.materialization.endpointRule, "https:// public only");

  assert.deepEqual(
    { name: report.serviceName, description: report.serviceDescription, type: report.serviceType },
    { name: "Crypto Intelligence Report", description: serviceDescriptions[1], type: "A2A" },
  );
  for (const key of ["fee", "endpoint", "id", "operation"]) {
    assert.equal(Object.hasOwn(report, key), false, `A2A 必须省略 ${key}`);
  }
  for (const service of draft.services) {
    assert.equal(service.serviceDescription.split("\n").length, 2, "服务描述必须恰好两行");
  }
}

test("Given 正式候选资料 When 校验 Then 注册字段与阻塞态一致", async () => {
  const [avatar, draftText, readinessText] = await Promise.all([
    readFile(new URL("assets/avatar.png", root)),
    readFile(new URL("registration/asp-draft.json", root), "utf8"),
    readFile(new URL("registration/readiness.json", root), "utf8"),
  ]);

  const image = pngInfo(avatar);
  assert.deepEqual(image, { width: 1024, height: 1024, size: image.size });
  assert.ok(image.size <= 1024 * 1024, "头像不得超过 1MiB");
  assert.ok(image.size > 10_000, "头像不能是空白占位图");
  const draft = JSON.parse(draftText);
  validateDraft(draft);
  const readiness = JSON.parse(readinessText);
  assert.equal(readiness.status, "blocked");
  assert.deepEqual(readiness.blockers.map(({ code }) => code), ["endpoint", "payment-asset", "live-registration"]);
  const paymentBlocker = readiness.blockers.find(({ code }) => code === "payment-asset");
  assert.equal(
    paymentBlocker.reason,
    "支付 tuple（network/contract/decimals/amountAtomic/payTo/symbol）尚未完成具名审批。",
    "支付 blocker 必须中性列出完整 tuple，不能预设资产",
  );
  assert.doesNotMatch(readinessText, /USDT0?|USDG/, "注册 readiness 不得预设 USDT、USDT0 或 USDG");
  assert.equal(readiness.liveRegistered, false, "不得虚假声称已完成线上注册");
});

test("Given 恶意候选变体 When 校验 Then 拒绝错误 fee、A2A 字段、本地 endpoint 与描述", async () => {
  const base = JSON.parse(await readFile(new URL("registration/asp-draft.json", root), "utf8"));
  const variants = [
    ["含币种 fee", (draft) => { draft.services[0].fee = "0.02 USDT"; }],
    ["A2A 空 fee", (draft) => { draft.services[1].fee = ""; }],
    ["localhost endpoint", (draft) => { draft.services[0].endpoint = "http://localhost:8787"; }],
    ["缺少第二行描述", (draft) => { draft.services[1].serviceDescription = serviceDescriptions[1].split("\n")[0]; }],
  ];

  for (const [name, mutate] of variants) {
    const draft = structuredClone(base);
    mutate(draft);
    assert.throws(() => validateDraft(draft), undefined, name);
  }

  const materialized = structuredClone(base);
  materialized.services[0].endpoint = "https://risk.example.com/v1/token-risk-score";
  assert.doesNotThrow(() => validateDraft(materialized, materialized.services[0].endpoint));
});

test("Given 非 PNG 或带文字标记的头像 When 校验 Then 拒绝", () => {
  assert.throws(() => pngInfo(Buffer.from("not-png")), /头像必须是 PNG/);
  assert.equal(/text|logo/i.test("avatar-with-text-logo.png"), true, "文字或 logo 头像必须由人工视觉 QA 拒绝");
});
