export function syntheticAdapter(responses, calls = []) {
  return async ({ network, address, signal }) => {
    calls.push({ network, address, signal });
    const response = responses.get(`${network}|${address}`);
    if (response instanceof Error) throw response;
    return structuredClone(response);
  };
}

export function approvedPolicy(sourceId, chains, overrides = {}) {
  return {
    policyVersion: "synthetic-v1",
    status: "ready",
    sources: [{
      id: sourceId,
      endpoint: "https://synthetic.invalid/token",
      plan: "synthetic",
      docsUrl: "https://synthetic.invalid/docs",
      termsUrl: "https://synthetic.invalid/terms",
      reviewedAt: "2026-07-10T00:00:00.000Z",
      commercialServerUse: "yes",
      derivativePaidOutput: "yes",
      cache: "yes",
      attribution: "Synthetic only",
      realFixtureRetention: "yes",
      rateLimitPerMinute: 60,
      costPerAttemptUsd: 0,
      chains,
      status: "approved",
      approvedBy: "Test Approver",
      approvedAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-12T00:00:00.000Z",
      ...overrides
    }]
  };
}
