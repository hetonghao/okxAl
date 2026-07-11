# Crypto Intel Node 注册运行手册

当前状态：`blocked`。本目录只保存注册候选资料，不代表 Agent 已创建、注册、激活或在线。

`registration/asp-draft.json` 不是可直接导入的 CLI manifest。它故意不包含 A2MCP endpoint；A2A 服务也故意省略 `fee`、`endpoint`、`id` 和 `operation`。

## 解锁条件

1. 部署 `Token Risk Score`，取得真实、公开可访问、长度不超过 512 字符的 `https://` endpoint；拒绝 localhost、私网、mock 和占位 URL。
2. 对支付网络、资产合约、decimals、`amountAtomic`、`payTo` 和 symbol 完成具名审批；不得仅凭 `USDT` 名称推断具体资产。
3. 再次核对 Agent 名称可用性、头像文件、两项服务字段和默认语言 `zh-CN`。
4. 获得新的明确授权后，才可登录钱包、处理 OTP、上传头像或执行 create/activate 等平台写操作。

## 授权后的物化步骤

1. 复制候选资料到临时工作副本，仅向 `Token Risk Score` 服务加入已验证的公网 HTTPS `endpoint`。
2. 保持 API fee 为字符串 `"0.02"`；不要附加 `USDT`。保持 A2A 服务完全不含 fee/endpoint/id/operation。
3. 使用当时安装的 OKX Agent CLI 帮助与 `validate-listing` 核对真实参数，不把本草稿直接传给 CLI。
4. 上传 `assets/avatar.png` 后，使用返回的真实图片 URL组装 create 参数。
5. 执行 create 前保存脱敏命令摘要；执行后保存真实 Agent ID、服务 ID、平台响应与时间戳。
6. 只有 create、activate、agent refresh 和服务探测均有真实成功证据时，才把 readiness 改为 ready。

## 失败与回滚

- 任一 blocker 未清除、校验失败、响应字段不完整或状态未知：停止，不重试不可逆写操作，并保持 `blocked`。
- create 成功但 activate 失败：记录真实 Agent ID 和失败响应，不虚报在线；按平台当前 CLI 手册人工处理。
- endpoint 或支付资产发生变化：重新走审批和校验，不沿用旧证据。
