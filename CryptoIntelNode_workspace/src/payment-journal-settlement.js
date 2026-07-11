export function storedSuccessResponse(response) {
  const body = response.body;
  const dimension = ({ score, status }) => ({ score, status });
  return {
    status: response.status,
    body: {
      schemaVersion: body.schemaVersion,
      scoreVersion: body.scoreVersion,
      requestId: body.requestId,
      asset: { network: body.asset.network, address: body.asset.address },
      assessment: {
        score: body.assessment.score,
        level: body.assessment.level,
        confidence: body.assessment.confidence,
      },
      dimensions: {
        security: dimension(body.dimensions.security),
        liquidity: dimension(body.dimensions.liquidity),
        concentration: dimension(body.dimensions.concentration),
      },
      freshness: {
        observedAt: body.freshness.observedAt,
        expiresAt: body.freshness.expiresAt,
        stale: body.freshness.stale,
      },
      evidence: body.evidence.map(({ dimension: name, source, summary, observedAt }) => ({
        dimension: name, source, summary, observedAt,
      })),
      missing: [...body.missing],
      conflicts: [...body.conflicts],
      disclaimer: body.disclaimer,
    },
  };
}

export function settledSuccessfully(value) {
  return value?.success === true
    && (value.status === undefined || value.status === "success")
    && typeof value.transaction === "string" && value.transaction.length > 0
    && typeof value.network === "string" && value.network.length > 0;
}
