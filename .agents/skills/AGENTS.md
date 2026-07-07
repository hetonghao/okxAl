# Shared Skills Directory

## OVERVIEW
根目录 `.agents/skills/` 只放跨 agent 复用的 OKX.AI / Onchain OS skill 资料。agent 私有内容放回对应 `{AgentName}_workspace/.agents/skills/`。

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| 共享 skill 文档 | `.agents/skills/` | 只提交不含密钥、可复用的资料 |
| agent 专属 skill | `{AgentName}_workspace/.agents/skills/` | 和单个 agent 绑定的内容放这里 |
| 临时登录态 | 不进仓库 | wallet、codex、OTP、cookie 都属于运行态 |

## CONVENTIONS
- skill 目录可以按 skill 名称建子目录，目录内优先用 `SKILL.md` 作入口。
- 共享资料必须能被多个 agent 使用；否则放到对应 agent 工作区。
- 不提交任何密钥、账号验证码、会话文件、浏览器缓存、钱包导出文件。

## ANTI-PATTERNS
- 不把“一拳超人”的专属 prompt 放到根 `.agents/skills/`。
- 不复制全局已安装的 OKX skills 源码，除非需要维护本仓库专属补丁。
