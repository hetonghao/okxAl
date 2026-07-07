# OKX.AI Agent Workspace Knowledge Base

**Generated:** 2026-07-07
**Commit:** 71a8832
**Branch:** main

## OVERVIEW
本仓库用于管理 OKX.AI / Onchain OS 上架相关的 ASP 工作区。当前按 agent 分目录隔离，根目录只放共享规范和少量运行说明。

## STRUCTURE
```text
okxAI/
├── .agents/
│   └── skills/                 # 根工作区共享 skill 目录
├── OnePunchMan_workspace/      # Agent: 一拳超人
│   └── .agents/
│       └── skills/             # 该 agent 独立 skill 目录
├── .gitignore
└── AGENTS.md
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| 新增 agent 工作区 | `{AgentName}_workspace/` | 每个 agent 单独目录，避免配置和技能混用 |
| agent 专属 skills | `{AgentName}_workspace/.agents/skills/` | 当前 agent 私有技能、提示词、工具说明放这里 |
| 共享 skills | `.agents/skills/` | 跨 agent 复用且不含密钥的内容放这里 |
| 一拳超人 ASP | `OnePunchMan_workspace/` | 当前首个 OKX.AI ASP 工作区 |
| 长久在线运行 | 广州服务器 `/root/okxAl` | 本机是移动工作电脑，不作为 7x24 承载节点 |

## CONVENTIONS
- 和用户交流、给用户看的文档统一用中文。
- 每个工作目录都必须保留 `.agents/skills/`。
- agent 工作区命名使用 `{AgentName}_workspace`，例如 `OnePunchMan_workspace`。
- agent 之间默认隔离：skills、提示词、运行说明优先放到各自工作区。
- 只有确认可复用、且不含密钥的内容才放根目录 `.agents/skills/`。
- 不提交钱包密钥、OpenAI/API key、OTP、cookie、session、`auth.json`、`config.toml` 等敏感运行态文件。
- 修改服务器运行配置后，要用真实命令确认 `codex exec`、`okx-a2a` daemon、agent 在线状态，不只看本地文件。
- A2A 入站系统事件要走快速路径：优先执行平台消息要求的下一步 CLI，不要先长篇解释或大段读取无关文档；只有 CLI 返回的脚本要求时再读对应 playbook。

## CODE MAP
当前仓库还不是代码项目，没有可索引源码入口；未发现 `.codegraph/`，因此暂不维护符号级 code map。

## COMMANDS
```bash
# 本地查看工作树
git status --short --branch

# 服务器同步仓库
ssh root@134.175.246.38
cd /root/okxAl
git pull --ff-only

# 服务器检查 Codex 可用性
cd /root/okxAl
codex exec --skip-git-repo-check --json "Reply exactly OK and nothing else."

# 服务器检查 OKX A2A 常驻状态
systemctl --user status okx-a2a --no-pager
okx-a2a daemon status
okx-a2a agent refresh --json
```

## ANTI-PATTERNS
- 不在根目录混放多个 agent 的私有技能或提示词。
- 不把本机运行状态当作 OKX.AI 审核的 7x24 在线证据。
- 不把一次性验证码、邮箱登录码、API key 写进仓库。
- 不在未验证服务器 daemon 和心跳的情况下重新提交上架审核。

## NOTES
- 本机负责编辑、提交、推送；广州服务器负责长期在线和平台检测。
- 后续新增 ASP 时，先创建新的 `{AgentName}_workspace/`，再补 `.agents/skills/`。
- 空目录无法被 git 跟踪，使用 `.gitkeep` 固定必须存在的目录。
- 广州服务器的 `okx-a2a.service` 需要固定 `WorkingDirectory=/root/okxAl`，避免 AI 子会话从 `/root` 启动导致上下文膨胀。
