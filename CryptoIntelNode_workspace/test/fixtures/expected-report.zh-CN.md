# Crypto Intel Node — 代币风险情报报告

## 执行摘要
- 网络：eip155:1
- 地址：0x1111111111111111111111111111111111111111
- 风险分数：74/100
- 风险等级：高
- 置信度：0.54（证据完整度乘数，不是统计概率）
- 评分版本：risk-v1.0.0

## 总风险
当前确定性评分为 74/100，等级为高。重点维度：security。

## 三个维度
### security
- 分数：80/100
- 状态：冲突
- 证据：[E3] [E4]

### concentration
- 分数：50/100
- 状态：新鲜
- 证据：[E1]

### liquidity
- 分数：75/100
- 状态：陈旧
- 证据：[E2]

## 证据与时间戳
- [E1] dimension=concentration | ruleId=concentration.label.medium | source=alpha | observedAt=2026-07-11T00:00:00.000Z | score=50 | status=fresh
- [E2] dimension=liquidity | ruleId=liquidity.10k-50k | source=alpha | observedAt=2026-07-10T23:00:00.000Z | score=75 | status=stale
- [E3] dimension=security | ruleId=security.risk-control.1 | source=alpha | observedAt=2026-07-11T00:00:00.000Z | score=10 | status=fresh
- [E4] dimension=security | ruleId=security.risk-control.4 | source=beta | observedAt=2026-07-11T00:00:00.000Z | score=80 | status=fresh

## 新鲜度
- 新鲜证据：concentration, security
- 陈旧证据：liquidity

## 缺失与冲突
- 缺失：无
- 冲突：security（source_disagreement，10–80，来源 alpha, beta）

## 边界说明
本报告只呈现已验证证据及确定性评分，不补充外部事实，也不构成投资建议或代替独立判断。
