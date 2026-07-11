# Crypto Intel Node Workspace

## OVERVIEW
`CryptoIntelNode_workspace/` 是 Crypto Intel Node 的独立工作区，面向交易与研究 Agent 提供可核验的 EVM 代币风险评分与情报报告。

## STRUCTURE
```text
CryptoIntelNode_workspace/
├── .agents/skills/   # 专属 skills
├── test/             # Node.js 原生测试
├── .env.example      # 非敏感环境变量示例
└── package.json      # Node.js ESM 项目入口
```

## CONVENTIONS
- 和用户交流、给用户看的文档统一用中文。
- 本工作区内必须保留 `.agents/skills/`。
- 使用 Node.js `>=22.14.0` 与 ESM。
- skills、提示词、配置和运行说明只服务于当前 Agent。
- 不提交钱包密钥、API key、OTP、cookie、session、`auth.json` 或 `config.toml`。

## COMMANDS
```bash
npm run check
npm test
npm run test:x402
npm run readiness
```
