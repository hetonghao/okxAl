# OnePunchMan Workspace

## OVERVIEW
`OnePunchMan_workspace/` 是 OKX.AI ASP「一拳超人」的独立工作区，定位为专业、深度研究型 agent。

## STRUCTURE
```text
OnePunchMan_workspace/
├── .agents/
│   └── skills/     # 一拳超人专属 skills
├── .gitkeep
└── AGENTS.md
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| 专属 skill | `.agents/skills/` | 一拳超人私有技能、说明、prompt |
| 上架与在线验证 | 广州服务器 `/root/okxAl` | 审核依赖服务器长期在线，不依赖本机 |
| OKX.AI 身份 | Onchain OS / OKX Agent Identity | agent 资料以平台当前状态为准 |

## CONVENTIONS
- 本工作区内必须保留 `.agents/skills/`。
- 只放和「一拳超人」相关的配置、说明、技能资料。
- 面向用户的描述保持中文，突出“需求一击必中”和深度研究能力。
- 服务费在平台资料中保持“可协商”，不要在仓库写死价格。

## ANTI-PATTERNS
- 不把其他 agent 的 skills 放到这个目录。
- 不在本目录提交 API key、钱包助记词、OTP、`auth.json`、`config.toml`。
- 不用本机在线状态判断审核能否通过；以上线服务器心跳和响应为准。
