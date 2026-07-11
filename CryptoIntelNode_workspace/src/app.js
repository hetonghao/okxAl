import { randomUUID } from "node:crypto";

import express from "express";

import { HttpProblem, problemHandler } from "./errors.js";

const NETWORKS = new Set(["eip155:1", "eip155:56", "eip155:8453", "eip155:42161", "eip155:196"]);
const LOCALES = new Set(["zh-CN", "en-US"]);
const ADDRESS = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;

function validateQuery(request, _response, next) {
  const { network, address, locale = "zh-CN" } = request.query;
  if (typeof network !== "string" || typeof address !== "string") return next(new HttpProblem(400, "missing_parameter", "network and address are required"));
  if (!NETWORKS.has(network)) return next(new HttpProblem(422, "unsupported_network", "network is unsupported"));
  if (!ADDRESS.test(address)) return next(new HttpProblem(422, "invalid_address", "address is invalid"));
  if (typeof locale !== "string" || !LOCALES.has(locale)) return next(new HttpProblem(422, "invalid_locale", "locale is invalid"));
  request.riskQuery = { network, address: address.toLowerCase(), locale };
  next();
}

async function blockers(gateReader, admission, checks, includeAdmission = true) {
  const found = [];
  try {
    const gates = await gateReader();
    for (const name of ["source", "payment", "economics"]) if (gates?.[name]?.status !== 200) found.push(`${name}-gate`);
  } catch {
    found.push("gate-unavailable");
  }
  if (includeAdmission) {
    try {
      if (admission.readiness().status !== 200) found.push("admission-capacity");
    } catch {
      found.push("admission-unavailable");
    }
  }
  for (const [name, code] of [["cache", "cache-unavailable"], ["journal", "http-journal-unavailable"]]) {
    try {
      if ((await checks[name]()).status !== 200) found.push(code);
    } catch {
      found.push(code);
    }
  }
  try {
    const spool = await checks.spool();
    if (spool.status !== 200) {
      const reasons = Array.isArray(spool.blockers) && spool.blockers.length ? spool.blockers : ["unavailable"];
      found.push(...reasons.map((reason) => `a2a-${reason}`));
    }
  } catch {
    found.push("a2a-unavailable");
  }
  return [...new Set(found)].sort();
}

function body(result) {
  const assessment = result.assessment;
  const evidence = assessment.evidence;
  const expiries = evidence.map(({ expiresAt }) => expiresAt).filter(Boolean).sort();
  const observations = evidence.map(({ observedAt }) => observedAt).filter(Boolean).sort();
  return {
    schemaVersion: "1.0",
    scoreVersion: assessment.scoreVersion,
    requestId: result.requestId,
    asset: result.asset,
    assessment: { score: assessment.score, level: assessment.level, confidence: assessment.confidence },
    dimensions: assessment.dimensions,
    freshness: { observedAt: observations[0], expiresAt: expiries[0], stale: evidence.some(({ status }) => status === "stale") },
    evidence: evidence.map(({ dimension, source, ruleId, score, observedAt }) => ({ dimension, source, summary: `${ruleId}: ${score}`, observedAt })),
    missing: assessment.missing,
    conflicts: assessment.conflicts.map((conflict) => typeof conflict === "string" ? conflict : JSON.stringify(conflict)),
    disclaimer: result.locale === "en-US" ? "For risk research only; not investment advice." : "仅供风险研究，不构成投资建议。",
  };
}

function reserve(admission, paymentMiddleware, riskService) {
  return (request, response, next) => {
    admission.run(() => new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        response.off("finish", finish);
        response.off("close", finish);
        error ? reject(error) : resolve();
      };
      response.once("finish", finish);
      response.once("close", finish);
      const paid = (error) => {
        if (error) return finish(error);
        Promise.resolve(riskService.assess(request.riskQuery)).then((result) => response.status(200).json(body(result)), finish);
      };
      try {
        const pending = paymentMiddleware(request, response, paid);
        if (pending?.catch) pending.catch(finish);
      } catch (error) {
        finish(error);
      }
    })).catch(next);
  };
}

export function createApp({ riskService, paymentMiddleware, gateReader, admission, readinessChecks, logger = console.log, version = "0.0.0", requestId = randomUUID } = {}) {
  if (!riskService || typeof paymentMiddleware !== "function" || typeof gateReader !== "function" || !admission || !readinessChecks) throw new TypeError("HTTP dependencies are required");
  const app = express();
  app.use((request, response, next) => {
    request.requestId = requestId();
    const started = performance.now();
    let logged = false;
    const log = () => {
      if (logged) return;
      logged = true;
      const route = request.path === "/v1/token-risk-score" ? "/v1/token-risk-score" : request.path;
      logger({ requestId: request.requestId, route, status: response.statusCode, duration: Math.round(performance.now() - started) });
    };
    response.once("finish", log);
    response.once("close", log);
    next();
  });
  app.get("/healthz", (_request, response) => response.json({ status: "ok", version }));
  app.get("/readyz", async (_request, response, next) => {
    try {
      const current = await blockers(gateReader, admission, readinessChecks);
      response.status(current.length ? 503 : 200).json({ status: current.length ? "blocked" : "ready", blockers: current });
    } catch (error) {
      next(error);
    }
  });
  app.get("/v1/token-risk-score", validateQuery, async (request, response, next) => {
    const current = await blockers(gateReader, admission, readinessChecks, false);
    if (current.length) return next(new HttpProblem(503, current.includes("payment-gate") ? "payment_gate_blocked" : "upstream_unavailable", "service readiness is blocked", { retryAfter: 1 }));
    next();
  }, reserve(admission, paymentMiddleware, riskService));
  app.use(problemHandler);
  return app;
}
