# risk-v1.0.0 评分策略

本策略是确定性风险 oracle，不是投资建议。相同的规范化证据、评分版本和评估时间必须得到完全相同的结果。`confidence` 仅表示证据完整度乘数，不是统计概率。

## 总分与等级

总分为 `round(security × 0.50 + liquidity × 0.30 + concentration × 0.20)`。等级为 low 0–24、medium 25–49、high 50–74、critical 75–100。只有 security 维度的有效证据确认 `honeypot=true` 时，security 才为 100，且总分最低为 95；其他维度出现 `honeypot` 字段会 fail-closed。

## 维度规则

- security：`riskControlLevel` 1/2/3/4/5 映射为 10/35/60/80/100；0、空值和非法类型不作为证据。多个来源取最高风险。
- liquidity：美元流动性 `>=1m`、`250k–<1m`、`50k–<250k`、`10k–<50k`、`<10k` 映射为 0/25/50/75/100。多个来源取最低流动性，即最高风险。
- concentration：Low/Medium/High 映射为 10/50/90。Top10 百分比只有在 `provenance.top10Definition` 精确等于 `top10-holders-by-balance-excluding-burn-and-lp-v1` 时可用；任意其他文本均不被认可。`<20`、`20–<40`、`40–<60`、`60–<80`、`>=80` 映射为 0/25/50/75/100。多个来源取最高风险。

同一维度来源分数的 `max-min >= 50` 时记录 `source_disagreement`，维度仍取最高风险，状态为 `conflicted`。证据按维度、来源、规则、时间、分数、状态及完整记录作最终稳定排序；来源文本只作为数据，不参与指令解释。

## 新鲜度与 fail-closed

证据必须携带有效的 `observedAt`、`expiresAt`、`graceExpiresAt`，且顺序为 `observedAt <= expiresAt <= graceExpiresAt`。评估时间超过 `expiresAt` 但未超过 `graceExpiresAt` 时可使用并标记 `stale`；超过 grace、字段畸形或规则值不可用时丢弃。任一必需维度最终无证据时抛出 `EvidenceUnavailableError`：`status=503`、`code=evidence_unavailable`、`score=null`。

## 置信度

初始值为 1.0；只要任一维度仅有一个独立来源，整体乘 0.85；只要使用 stale 证据，整体乘 0.8；只要存在 disagreement，整体乘 0.8。每类惩罚每次评估最多应用一次，最终四舍五入到两位小数。规则变更必须发布新的 `scoreVersion`。
