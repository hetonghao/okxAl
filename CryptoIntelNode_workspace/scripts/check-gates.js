#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredSourceStrings = ["id", "endpoint", "plan", "docsUrl", "termsUrl", "reviewedAt", "attribution"];
const explicitYesFields = ["commercialServerUse", "derivativePaidOutput", "cache", "realFixtureRetention"];
const evmAddress = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validDate(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function placeholder(value) {
  return typeof value !== "string" || value.trim() === "" || /^(unknown|pending)$/i.test(value.trim());
}

function httpsUrl(value) {
  if (placeholder(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function approvalReasons(record, label, nowMs) {
  const reasons = [];
  if (record?.status !== "approved") reasons.push(`${label}.status must be approved`);
  if (placeholder(record?.approvedBy)) reasons.push(`${label}.approvedBy is required`);
  if (!validDate(record?.approvedAt)) reasons.push(`${label}.approvedAt is required`);
  else if (Date.parse(record.approvedAt) > nowMs) reasons.push(`${label}.approvedAt cannot be in the future`);
  if (!validDate(record?.expiresAt)) reasons.push(`${label}.expiresAt is required`);
  else if (Date.parse(record.expiresAt) <= nowMs) reasons.push(`${label}.approval expired`);
  else if (validDate(record?.approvedAt) && Date.parse(record.expiresAt) <= Date.parse(record.approvedAt)) reasons.push(`${label}.expiresAt must follow approvedAt`);
  return reasons;
}

function sourceReasons(source, index, nowMs) {
  const label = `sources[${index}]`;
  if (!object(source)) return [`${label} must be an object`];
  const reasons = approvalReasons(source, label, nowMs);
  for (const field of requiredSourceStrings) if (placeholder(source[field])) reasons.push(`${label}.${field} is required`);
  for (const field of ["endpoint", "docsUrl", "termsUrl"]) if (!httpsUrl(source[field])) reasons.push(`${label}.${field} must be an exact HTTPS URL`);
  if (!validDate(source.reviewedAt) || Date.parse(source.reviewedAt) > nowMs) reasons.push(`${label}.reviewedAt must be a current or past date`);
  for (const field of explicitYesFields) {
    if (source[field] !== "yes") reasons.push(`${label}.${field} must be yes`);
  }
  if (!Number.isInteger(source.rateLimitPerMinute) || source.rateLimitPerMinute <= 0) reasons.push(`${label}.rateLimitPerMinute must be positive`);
  if (!finiteNumber(source.costPerAttemptUsd) || source.costPerAttemptUsd < 0) reasons.push(`${label}.costPerAttemptUsd must be non-negative`);
  if (!Array.isArray(source.chains) || source.chains.length === 0 || source.chains.some((chain) => typeof chain !== "string" || chain === "")) {
    reasons.push(`${label}.chains must be non-empty`);
  }
  return reasons;
}

export function evaluateGates(input, now = new Date().toISOString()) {
  const fixture = object(input) ?? {};
  const dataSources = object(fixture.dataSources);
  const payment = object(fixture.payment);
  const economics = object(fixture.economics);
  const nowMs = Date.parse(now);
  const reasons = [];
  const sources = Array.isArray(dataSources?.sources) ? dataSources.sources : [];

  if (!Number.isFinite(nowMs)) reasons.push("now must be a valid date");
  if (!dataSources) reasons.push("dataSources must be an object");
  if (typeof dataSources?.policyVersion !== "string" || dataSources.policyVersion === "") reasons.push("dataSources.policyVersion is required");
  if (sources.length === 0) reasons.push("dataSources.sources must be non-empty");
  sources.forEach((source, index) => reasons.push(...sourceReasons(source, index, nowMs)));

  if (!payment) reasons.push("payment must be an object");
  else {
    reasons.push(...approvalReasons(payment, "payment", nowMs));
    if (payment.listingFee !== "0.02") reasons.push("payment.listingFee must be 0.02");
    if (payment.runtimePrice !== "$0.02") reasons.push("payment.runtimePrice must be $0.02");
    const tuple = object(payment.tuple);
    if (!tuple) reasons.push("payment.tuple must be an object");
    else {
      if (typeof tuple.network !== "string" || !/^eip155:[1-9][0-9]*$/.test(tuple.network)) reasons.push("payment.tuple.network is invalid");
      if (!evmAddress.test(tuple.contract ?? "")) reasons.push("payment.tuple.contract is invalid");
      if (!Number.isSafeInteger(tuple.decimals) || tuple.decimals <= 0) reasons.push("payment.tuple.decimals is invalid");
      if (typeof tuple.amountAtomic !== "string" || !/^[1-9][0-9]*$/.test(tuple.amountAtomic)) reasons.push("payment.tuple.amountAtomic is invalid");
      if (!evmAddress.test(tuple.payTo ?? "")) reasons.push("payment.tuple.payTo is invalid");
      if (placeholder(tuple.symbol)) reasons.push("payment.tuple.symbol is required");
    }
    if (!finiteNumber(payment.settlementCostUsd) || payment.settlementCostUsd < 0) reasons.push("payment.settlementCostUsd must be non-negative");
    if (object(payment.a2aQuote)?.mode !== "separate") reasons.push("payment.a2aQuote.mode must be separate");
  }

  if (!economics) reasons.push("economics must be an object");
  else {
    reasons.push(...approvalReasons(economics, "economics", nowMs));
    if (!Number.isInteger(economics.maxSourceAttempts) || economics.maxSourceAttempts < 1) reasons.push("economics.maxSourceAttempts must be positive");
    if (!finiteNumber(economics.marginalInfraCostUsd) || economics.marginalInfraCostUsd < 0) reasons.push("economics.marginalInfraCostUsd must be non-negative");
    if (!finiteNumber(economics.failureReserveUsd) || economics.failureReserveUsd < 0.001) reasons.push("economics.failureReserveUsd must be at least 5% of price");
    if (!finiteNumber(economics.minimumFailureReserveRate) || economics.minimumFailureReserveRate < 0.05) reasons.push("economics.minimumFailureReserveRate must be at least 0.05");
    if (economics.minimumNetContributionUsd !== 0.005) reasons.push("economics.minimumNetContributionUsd must be 0.005");
    if (economics.cacheHitRateAssumption !== 0) reasons.push("economics.cacheHitRateAssumption must be zero");
  }

  const costs = sources.map((source) => source?.costPerAttemptUsd).filter(finiteNumber);
  const maxRetrySourceCost = costs.length > 0 && Number.isInteger(economics?.maxSourceAttempts)
    ? Math.max(...costs) * economics.maxSourceAttempts
    : null;
  const calculable = maxRetrySourceCost !== null && finiteNumber(payment?.settlementCostUsd)
    && finiteNumber(economics?.marginalInfraCostUsd) && finiteNumber(economics?.failureReserveUsd);
  const netContributionUsd = calculable
    ? Number((0.02 - maxRetrySourceCost - payment.settlementCostUsd - economics.marginalInfraCostUsd - economics.failureReserveUsd).toFixed(6))
    : null;
  if (netContributionUsd === null || netContributionUsd < 0.005) reasons.push("net contribution must be at least 0.005 USD");

  return {
    status: reasons.length === 0 ? "ready" : "blocked",
    ready: reasons.length === 0,
    reasons,
    economics: { formula: "0.02 - maxRetrySourceCost - settlementCost - marginalInfraCost - failureReserve", maxRetrySourceCost, netContributionUsd },
  };
}

function args(argv) {
  const paths = {
    dataSources: resolve(workspace, "readiness/data-sources.json"),
    payment: resolve(workspace, "readiness/payment.json"),
    economics: resolve(workspace, "readiness/unit-economics.json"),
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = { "--data-sources": "dataSources", "--payment": "payment", "--economics": "economics" }[argv[index]];
    if (!key || !argv[index + 1]) throw new Error(`invalid argument: ${argv[index] ?? ""}`);
    paths[key] = resolve(argv[index + 1]);
  }
  return paths;
}

async function main() {
  try {
    const paths = args(process.argv.slice(2));
    const [dataSources, payment, economics] = await Promise.all(Object.values(paths).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    const result = evaluateGates({ dataSources, payment, economics });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.error(JSON.stringify({ status: "blocked", ready: false, reasons: [error instanceof Error ? error.message : "unknown error"] }, null, 2));
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
