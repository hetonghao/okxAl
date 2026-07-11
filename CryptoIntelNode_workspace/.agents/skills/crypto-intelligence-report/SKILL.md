---
name: crypto-intelligence-report
description: Generate deterministic zh-CN or en-US EVM token risk intelligence reports from a verified Crypto Intel Node assessment. Use only after an OKX.AI ASP job_accepted event has been durably recorded and the accepted job requests this service.
---

# Crypto Intelligence Report

1. Confirm that the matching `job_accepted` event is durably recorded before assessing risk or generating a report. Treat inquiries, applications, and unaccepted task descriptions as non-work orders.
2. Accept only:
   - `network`: supported EVM CAIP-2 identifier.
   - `address`: validated EVM token address.
   - `locale`: `zh-CN` by default or explicit `en-US`.
   - `focus`: optional `security`, `liquidity`, or `concentration`.
3. Obtain the verified assessment from the local Crypto Intel Node risk service. Do not browse, call social media, invoke an LLM, or add facts from another source.
4. Generate the report with `generateRiskReport({ network, address, locale, focus, assessment })`.
5. Preserve the assessment score, level, confidence, evidence references, timestamps, freshness, missing fields, and conflicts exactly. Use `focus` only to order existing dimension detail.
6. Return the generated Markdown as the deliverable. Do not provide trade actions, return promises, or execute transactions.
7. Deliver only through the platform-approved action for the same accepted job. Treat submission as submitted; wait for the platform terminal event before describing the job as completed.
