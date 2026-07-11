# Crypto Intel Node — Token Risk Intelligence Report

## Executive Summary
- Network: eip155:1
- Address: 0x1111111111111111111111111111111111111111
- Risk score: 74/100
- Risk level: high
- Confidence: 0.54 (evidence-completeness multiplier, not a statistical probability)
- Score version: risk-v1.0.0

## Overall Risk
The deterministic score is 74/100 with a high risk level. Focus dimension: security.

## Three Dimensions
### security
- Score: 80/100
- Status: conflicted
- Evidence: [E3] [E4]

### concentration
- Score: 50/100
- Status: fresh
- Evidence: [E1]

### liquidity
- Score: 75/100
- Status: stale
- Evidence: [E2]

## Evidence and Timestamps
- [E1] dimension=concentration | ruleId=concentration.label.medium | source=alpha | observedAt=2026-07-11T00:00:00.000Z | score=50 | status=fresh
- [E2] dimension=liquidity | ruleId=liquidity.10k-50k | source=alpha | observedAt=2026-07-10T23:00:00.000Z | score=75 | status=stale
- [E3] dimension=security | ruleId=security.risk-control.1 | source=alpha | observedAt=2026-07-11T00:00:00.000Z | score=10 | status=fresh
- [E4] dimension=security | ruleId=security.risk-control.4 | source=beta | observedAt=2026-07-11T00:00:00.000Z | score=80 | status=fresh

## Freshness
- Fresh evidence: concentration, security
- Stale evidence: liquidity

## Missing and Conflicts
- Missing: none
- Conflicts: security (source_disagreement, 10–80, sources alpha, beta)

## Boundaries
This report presents only verified evidence and deterministic scoring. It adds no external facts and is not investment advice or a substitute for independent judgment.
