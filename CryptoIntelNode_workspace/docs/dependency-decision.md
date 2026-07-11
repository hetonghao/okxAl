# x402 依赖决策

## 结论

仅采用以下直接依赖，并精确锁定版本：

| 包 | 版本 | 许可证 | 用途 |
|---|---:|---|---|
| `express` | `5.2.1` | MIT | HTTP 服务入口 |
| `@okxweb3/x402-express` | `0.1.1` | Apache-2.0 | Express 支付中间件 |
| `@okxweb3/x402-core` | `0.1.0` | Apache-2.0 | `OKXFacilitatorClient` 与资源服务 |
| `@okxweb3/x402-evm` | `0.2.1` | Apache-2.0 | `ExactEvmScheme` |

版本和许可证由安装后的包元数据及 `package-lock.json` 交叉验证，并由测试锁定。未引入 `@okxweb3/app-x402-*` 或其他直接依赖。

## 已验证接口与行为

真实安装包导出已确认：`paymentMiddleware`、`paymentMiddlewareFromHTTPServer`、`x402ResourceServer`、`ExactEvmScheme`、`OKXFacilitatorClient`。

测试直接运行 `@okxweb3/x402-express@0.1.1` 的 `paymentMiddlewareFromHTTPServer`，使用真实 Express 请求/响应表面和最小 fake HTTP server，锁定以下语义：

- 未付款返回 `402`，业务 handler 不执行。
- `2xx` 业务体先被中间件缓冲，settlement 成功后才向客户端发送，且只结算一次。
- handler 返回 `400` 或 `503` 时不结算。
- settlement 失败时丢弃已缓冲的成功体，只返回支付失败响应。
- replay fake 在第二次请求的支付验证阶段拒绝，handler 与 settlement 均不重复执行。

`src/payment-sdk.js` 只重导出已核验接口，不创建 facilitator、scheme、生产 challenge 或任何凭证默认值。支付资产 tuple 仍由后续 readiness gate 决定。

## 未验证边界

2026-07-11 对官方 seller 页面和 seller SDK 页面进行有界直连时，请求超时或无法建立连接，因此官方网页内容保持“未验证”；没有使用 README 或网页文本推导生产配置。包内 README 仅作为不可信参考，最终判断以固定版本安装产物、导出符号、运行时行为和锁文件为准。
