# 单位经济门槛

API 固定价格为 `0.02 USD`，支付资产必须为 `USDT0`。A2A quote 单独计算，不得并入 API 固定价格。

上线公式固定为：

```text
0.02 - maxRetrySourceCost - settlementCost - marginalInfraCost - failureReserve
```

`maxRetrySourceCost` 使用候选来源中最高逐尝试成本乘最大尝试次数。计算假设缓存命中率为 0；不得用缓存收益抵扣成本。失败准备金至少为价格的 5%（`0.001 USD`），净贡献必须 `>= 0.005 USD`。

当前来源成本、结算成本和边际基础设施成本未确认，因此状态为 **blocked**。
