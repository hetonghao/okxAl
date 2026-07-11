# 单位经济门槛

平台 listing fee 固定为 `"0.02"`，HTTP runtime price 固定为 `"$0.02"`。A2A quote 单独计算，不得并入 API 固定价格。

支付资产不按 symbol 推断。上线前必须由具名审批同时确认 `network`、`contract`、`decimals`、`amountAtomic`、`payTo`、`symbol` 六字段；官方 SDK 生成的 PaymentRequirements 必须逐字段匹配。当前未选择真实资产、网络和收款地址，因此保持 **blocked**。

上线公式固定为：

```text
0.02 - maxRetrySourceCost - settlementCost - marginalInfraCost - failureReserve
```

`maxRetrySourceCost` 使用候选来源中最高逐尝试成本乘最大尝试次数。计算假设缓存命中率为 0；不得用缓存收益抵扣成本。失败准备金至少为价格的 5%（`0.001 USD`），净贡献必须 `>= 0.005 USD`。

当前来源成本、结算成本和边际基础设施成本未确认，因此状态为 **blocked**。
