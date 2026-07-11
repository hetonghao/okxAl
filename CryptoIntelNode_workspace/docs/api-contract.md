# Token Risk Score v1 API 契约

唯一付费业务入口：

```http
GET /v1/token-risk-score?network=<CAIP-2>&address=<EVM>&locale=zh-CN|en-US
```

`network` 和 `address` 必填；`locale` 可选，默认 `zh-CN`。地址必须是非零的 20-byte EVM 十六进制地址。

## 网络边界

分析网络只允许以下五个 CAIP-2 标识：

- Ethereum：`eip155:1`
- BNB Smart Chain：`eip155:56`
- Base：`eip155:8453`
- Arbitrum One：`eip155:42161`
- X Layer：`eip155:196`

分析网络与支付网络是两个独立概念。分析请求可指向上述任一网络；支付挑战由官方 OKX x402 中间件生成，当前契约单独声明支付网络 `eip155:196`，禁止从分析 `network` 推导或替换支付网络、资产及挑战内容。

## 成功响应

`200 application/json` 固定使用 `schemaVersion: "1.0"` 与 `scoreVersion: "risk-v1.0.0"`。响应包含 `requestId`、`asset`、`assessment`、`dimensions`、`freshness`、`evidence`、`missing`、`conflicts`、`disclaimer`。

`assessment.score` 及 security、liquidity、concentration 三个维度的 `score` 都是 0–100 的整数。任一必需维度不可用时不得返回数字总分，应返回 503 problem 响应。

## 错误响应

除 402 外，错误统一使用 `application/problem+json`，固定字段为 `type`、`title`、`status`、`code`、`detail`、`requestId`、`retryable`、`score`，且 `score` 必须为 `null`。

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `missing_parameter` | 缺少 `network` 或 `address` |
| 422 | `invalid_address` / `unsupported_network` / `invalid_locale` | 参数格式或语义非法 |
| 404 | `asset_not_found` | 上游已确认该网络上不存在该资产 |
| 503 | `evidence_unavailable` / `upstream_unavailable` | 证据不足或上游暂时失败 |

`402` 是官方 OKX x402 支付挑战：body 和 `WWW-Authenticate` / `PAYMENT-REQUIRED` 等 header 必须原样透传，不得包装成 problem+json。
