import {
  ExactEvmScheme,
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "./payment-sdk.js";

const ADDRESS = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;
const DEFAULT_TIMEOUT_MS = 10_000;

async function abortable(client, method, args, timeoutMs, requestSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(requestSignal?.reason);
  requestSignal?.addEventListener("abort", abort, { once: true });
  if (requestSignal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException(`${method} deadline exceeded`, "TimeoutError")), timeoutMs);
  timer.unref?.();
  try {
    return await client[method](...args, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener("abort", abort);
  }
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function paymentConfigReasons(config, now = new Date().toISOString()) {
  const reasons = [];
  const tuple = config?.tuple;
  const nowMs = Date.parse(now);
  if (config?.status !== "approved") reasons.push("payment.status must be approved");
  if (typeof config?.approvedBy !== "string" || !config.approvedBy.trim()) reasons.push("payment.approvedBy is required");
  if (!validDate(config?.approvedAt) || Date.parse(config.approvedAt) > nowMs) reasons.push("payment.approvedAt is invalid");
  if (!validDate(config?.expiresAt) || Date.parse(config.expiresAt) <= nowMs) reasons.push("payment approval expired");
  if (config?.listingFee !== "0.02") reasons.push("payment.listingFee must be 0.02");
  if (config?.runtimePrice !== "$0.02") reasons.push("payment.runtimePrice must be $0.02");
  if (config?.a2aQuote?.mode !== "separate") reasons.push("payment.a2aQuote.mode must be separate");
  if (typeof tuple?.network !== "string" || !/^eip155:[1-9][0-9]*$/.test(tuple.network)) reasons.push("payment.tuple.network is invalid");
  if (!ADDRESS.test(tuple?.contract ?? "")) reasons.push("payment.tuple.contract is invalid");
  if (!Number.isSafeInteger(tuple?.decimals) || tuple.decimals <= 0) reasons.push("payment.tuple.decimals is invalid");
  if (typeof tuple?.amountAtomic !== "string" || !/^[1-9][0-9]*$/.test(tuple.amountAtomic)) reasons.push("payment.tuple.amountAtomic is invalid");
  if (!ADDRESS.test(tuple?.payTo ?? "")) reasons.push("payment.tuple.payTo is invalid");
  if (typeof tuple?.symbol !== "string" || !tuple.symbol.trim()) reasons.push("payment.tuple.symbol is invalid");
  return reasons;
}

function sameAddress(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

export function assertApprovedRequirements(config, requirements) {
  const tuple = config.tuple;
  const requirement = requirements?.[0];
  if (
    requirements?.length !== 1 || requirement?.scheme !== "exact"
    || requirement.network !== tuple.network
    || !sameAddress(requirement.asset, tuple.contract)
    || requirement.amount !== tuple.amountAtomic
    || !sameAddress(requirement.payTo, tuple.payTo)
    || requirement.extra?.decimals !== tuple.decimals
    || requirement.extra?.symbol !== tuple.symbol
  ) throw new Error("payment tuple mismatch");
  return requirement;
}

function canonical(context) {
  return { method: context.method, path: context.path, query: context.adapter.getQueryParams() };
}

export async function createX402Payment({ config, facilitatorClient, journal, now, timeoutMs = DEFAULT_TIMEOUT_MS, dependencies = {} } = {}) {
  const reasons = paymentConfigReasons(config, now);
  if (reasons.length) throw new Error(`payment blocked: ${reasons.join("; ")}`);
  if (!facilitatorClient || !journal) throw new TypeError("facilitatorClient and journal are required");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
  const ResourceServer = dependencies.x402ResourceServer ?? x402ResourceServer;
  const Scheme = dependencies.ExactEvmScheme ?? ExactEvmScheme;
  const HTTPServer = dependencies.x402HTTPResourceServer ?? x402HTTPResourceServer;
  const middleware = dependencies.paymentMiddlewareFromHTTPServer ?? paymentMiddlewareFromHTTPServer;
  const scheme = new Scheme().registerMoneyParser(async (amount, network) => (
    amount === 0.02 && network === config.tuple.network
      ? { asset: config.tuple.contract, amount: config.tuple.amountAtomic, extra: { decimals: config.tuple.decimals, symbol: config.tuple.symbol } }
      : null
  ));
  const requests = new AsyncLocalStorage();
  const resourceServer = new ResourceServer({
    getSupported: (...args) => facilitatorClient.getSupported(...args),
    verify: (...args) => abortable(facilitatorClient, "verify", args, timeoutMs, requests.getStore()),
    settle: (...args) => abortable(facilitatorClient, "settle", args, timeoutMs, requests.getStore()),
  }).register(config.tuple.network, scheme);
  await resourceServer.initialize();
  const resourceConfig = { scheme: "exact", network: config.tuple.network, payTo: config.tuple.payTo, price: config.runtimePrice };
  assertApprovedRequirements(config, await resourceServer.buildPaymentRequirements(resourceConfig));
  const routes = {
    "GET /v1/token-risk-score": {
      accepts: resourceConfig,
      description: "EVM token risk intelligence score",
      mimeType: "application/json",
    },
  };
  const official = new HTTPServer(resourceServer, routes);
  const journaled = {
    registerPaywallProvider: (...args) => official.registerPaywallProvider(...args),
    initialize: () => official.initialize(),
    requiresPayment: (context) => official.requiresPayment(context),
    async processHTTPRequest(context, paywallConfig) {
      if (context.paymentHeader) {
        const replay = await journal.replay(context.paymentHeader, canonical(context));
        if (replay) return { type: "payment-error", response: { ...replay, headers: {}, isHtml: false } };
      }
      return official.processHTTPRequest(context, paywallConfig);
    },
    async processSettlement(paymentPayload, requirements, extensions, transport, overrides) {
      let settlement;
      const response = { status: 200, body: JSON.parse(transport.responseBody.toString()) };
      await journal.execute({
        paymentHeader: transport.request.paymentHeader,
        request: canonical(transport.request),
        response,
        settle: async () => {
          settlement = await official.processSettlement(paymentPayload, requirements, extensions, transport, overrides);
          return settlement;
        },
        flush: async () => {},
      });
      return settlement;
    },
  };
  const officialMiddleware = middleware(journaled, undefined, undefined, false);
  return (request, response, next) => requests.run(request.paymentSignal, () => officialMiddleware(request, response, next));
}
import { AsyncLocalStorage } from "node:async_hooks";
