# Crypto Intel Node 注册运行手册

当前状态：`blocked`。本目录只保存注册候选资料，不代表 Agent 已创建、注册、激活或在线。

`registration/asp-draft.json` 不是可直接导入的 CLI manifest。它故意不包含 A2MCP endpoint；A2A 服务也故意省略 `fee`、`endpoint`、`id` 和 `operation`。

## 解锁条件

1. 部署 `Token Risk Score`，取得真实、公开可访问、长度不超过 512 字符的 `https://` endpoint；拒绝 localhost、私网、mock 和占位 URL。
2. 对支付网络、资产合约、decimals、`amountAtomic`、`payTo` 和 symbol 完成具名审批；不得仅凭 `USDT` 名称推断具体资产。
3. 再次核对 Agent 名称可用性、头像文件、两项服务字段和默认语言 `zh-CN`。
4. 获得新的明确授权后，才可登录钱包、处理 OTP、上传头像或执行 create/activate 等平台写操作。

## 固定执行顺序

本轮不执行以下任何一步。后续获得另行授权后，也必须严格按顺序执行，不得把 health、402、testnet 或局部成功当成 live complete：

1. 取得另行授权。
2. 确认目标机、域名与 TLS。
3. 核验公网 HTTPS、真实 data、payment 与 economics。
4. 执行钱包 preflight。
5. 执行 ASP pre-check。
6. 执行头像 upload。
7. 身份卡 Reply 1。
8. 逐项装载两个服务并选择 add-another。
9. 由用户显式选择 Done。
10. 只执行一次 validate-listing。
11. 按发现项选择修正。
12. 最终服务卡 Reply 1。
13. 执行 create（newAgentId:null，不猜测、不自动追查）。
14. 完成通信初始化。
15. 执行 activate zh-CN。
16. 核验 marketplace listed。
17. 指定 serviceId 的真实 A2A job_accepted、deliver、submitted、completed。

API fee 保持字符串 `"0.02"`，不附加 `USDT`；A2A 服务不填 fee、endpoint、id 或 operation。每一步保存脱敏命令摘要、真实返回标识与时间戳，任一步证据缺失即保持 `blocked-external`。

## 失败与回滚

- 任一 blocker 未清除、校验失败、响应字段不完整或状态未知：停止，不重试不可逆写操作，并保持 `blocked`。
- create 成功但 activate 失败：记录真实 Agent ID 和失败响应，不虚报在线；按平台当前 CLI 手册人工处理。
- endpoint 或支付资产发生变化：重新走审批和校验，不沿用旧证据。
