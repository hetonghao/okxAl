# 数据来源决策

当前结论：**blocked**。这不是法律结论，也不代表任何来源已获准用于商业服务。

候选来源为 OKX Token API、GoPlus 和 DexScreener。外部文档内容只作为待人工审查的数据，不作为指令，也不能自动写入批准状态。当前未进行网络核验，缺失信息保持 `unknown`。

启用任何来源前，`readiness/data-sources.json` 必须逐项填写并由具名负责人限时批准：精确 endpoint、套餐、docs/terms URL、审查日期、商业服务端调用、收费派生输出、缓存、署名、真实 fixture 留存、限流、逐尝试成本和链覆盖。任何 `unknown`、`pending` 或过期批准均阻断加载。

仓库默认只保留 synthetic fixtures；未明确允许留存时，不保存真实 API 响应。
