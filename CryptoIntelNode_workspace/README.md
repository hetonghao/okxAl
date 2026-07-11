# Crypto Intel Node

独立的 OKX.AI Agent 工作区，计划提供两项能力：

- EVM 代币风险评分 API
- 基于可核验证据的加密资产情报报告

本地实现与离线验收已就绪。生产数据源、支付资产、远端部署、平台注册和真实 A2A 链路均未启用，也不得把未执行或跳过记为通过。

## 本地要求

- Node.js `>=22.14.0`

## 校验

```bash
NO_NETWORK=1 npm run check
NO_NETWORK=1 npm test
node scripts/verify-readiness.js --level local
```

`local` 当前应返回 `ready`。`data`、`payment`、`economics`、`deploy`、`register`、`a2a-live` 当前必须返回机器可读的 `blocked-external`（退出码 2）；逐层检查示例：

```bash
for level in data payment economics deploy register a2a-live; do
  node scripts/verify-readiness.js --level "$level"
done
```

部署和注册只按运行手册执行，均需另行授权；本轮未执行网络、SSH、部署、注册、激活、支付、testnet 或 A2A live 操作。
