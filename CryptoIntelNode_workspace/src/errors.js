export class HttpProblem extends Error {
  constructor(status, code, detail, { retryAfter } = {}) {
    super(detail);
    this.name = "HttpProblem";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function problemHandler(error, request, response, _next) {
  if (response.headersSent) return;
  const admission = error?.name === "AdmissionError";
  const known = error instanceof HttpProblem || admission;
  const status = known && Number.isInteger(error.status) ? error.status : 503;
  const code = status === 503
    ? error?.code === "evidence_unavailable" ? "evidence_unavailable" : "upstream_unavailable"
    : error instanceof HttpProblem ? error.code : "upstream_unavailable";
  if (Number.isInteger(error?.retryAfter)) response.set("Retry-After", String(error.retryAfter));
  response.status(status).type("application/problem+json").send({
    type: `https://crypto-intel-node.local/problems/${code}`,
    title: status === 400 ? "Bad Request" : status === 422 ? "Unprocessable Entity" : "Service Unavailable",
    status,
    code,
    detail: error instanceof HttpProblem ? error.message : "The service cannot complete this request safely.",
    requestId: request.requestId,
    retryable: status === 503,
    score: null,
  });
}
