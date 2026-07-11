#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LEVELS = ["local", "data", "payment", "economics", "deploy", "register", "a2a-live"];

export const REGISTRATION_STEPS = [
  "另行授权",
  "目标机、域名与 TLS",
  "公网 HTTPS、真实 data、payment 与 economics",
  "钱包 preflight",
  "ASP pre-check",
  "头像 upload",
  "身份卡 Reply 1",
  "逐项装载两个服务并选择 add-another",
  "用户显式选择 Done",
  "一次 validate-listing",
  "按发现项选择修正",
  "最终服务卡 Reply 1",
  "create（newAgentId:null，不猜测、不自动追查）",
  "通信初始化",
  "activate zh-CN",
  "marketplace listed",
  "指定 serviceId 的真实 A2A job_accepted、deliver、submitted、completed",
];

const externalBlockers = {
  data: [{ code: "real-data-evidence", reason: "真实数据源、许可、fixture 与限流证据尚未获批。" }],
  payment: [{ code: "real-payment-tuple", reason: "真实支付网络、资产、金额与收款地址 tuple 尚未获批。" }],
  economics: [{ code: "real-unit-economics", reason: "真实来源、结算、基础设施成本与失败准备金尚未核验。" }],
  deploy: [{ code: "authorized-live-deploy", reason: "目标机、域名、TLS、systemd、Nginx 与公网 HTTPS 尚无授权后的真实证据。" }],
  register: [{ code: "authorized-live-registration", reason: "完整注册顺序尚未获授权执行，create、activate 与 listed 均无真实证据。" }],
  "a2a-live": [{ code: "real-a2a-lifecycle", reason: "指定 serviceId 尚无真实 accepted、deliver、submitted、completed 全链路证据。" }],
};

async function localBlockers() {
  const required = [
    "package-lock.json",
    "readiness/data-sources.json",
    "readiness/payment.json",
    "readiness/unit-economics.json",
    "registration/readiness.json",
    "docs/deployment-runbook.md",
    "docs/registration-runbook.md",
  ];
  const missing = [];
  for (const file of required) {
    try {
      await access(resolve(workspace, file));
    } catch {
      missing.push({ code: "missing-local-artifact", reason: `${file} 不存在。` });
    }
  }
  const packageJson = JSON.parse(await readFile(resolve(workspace, "package.json"), "utf8"));
  if (packageJson.scripts?.readiness !== "node scripts/verify-readiness.js --level local") {
    missing.push({ code: "readiness-entrypoint", reason: "package readiness script 未指向分层验收入口。" });
  }
  return missing;
}

export async function evaluateReadiness(level) {
  if (!LEVELS.includes(level)) throw new TypeError(`level must be one of: ${LEVELS.join(", ")}`);
  const blockers = level === "local" ? await localBlockers() : externalBlockers[level];
  return {
    level,
    status: blockers.length === 0 ? "ready" : level === "local" ? "blocked" : "blocked-external",
    ready: blockers.length === 0,
    blockers,
  };
}

function parseLevel(argv) {
  if (argv.length !== 2 || argv[0] !== "--level") throw new TypeError("usage: verify-readiness.js --level <level>");
  return argv[1];
}

async function main() {
  try {
    const result = await evaluateReadiness(parseLevel(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify({ status: "blocked", ready: false, blockers: [{ code: "invalid-invocation", reason: error instanceof Error ? error.message : "unknown error" }] }));
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
