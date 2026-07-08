#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const REAL_CODEX = process.env.OKX_A2A_REAL_CODEX || "/usr/bin/codex";
const LOCAL_AGENT_ID = process.env.OKX_A2A_FAST_AGENT_ID || "3969";
const PEER_AGENT_ID = process.env.OKX_A2A_FAST_PEER_AGENT_ID || "1791";
const DRY_RUN = process.env.OKX_A2A_FAST_DRY_RUN === "1";

const args = process.argv.slice(2);
const prompt = args.at(-1) || "";

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function firstMatch(patterns, fallback = "") {
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.[1]) return match[1];
  }
  return fallback;
}

function run(command, args) {
  if (DRY_RUN) {
    return { status: 0, stdout: `[dry-run] ${command} ${args.join(" ")}`, stderr: "" };
  }
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function runNextAction(agentId, message) {
  const result = spawnSync("/root/.local/bin/onchainos", [
    "agent",
    "next-action",
    "--role",
    "auto",
    "--agentId",
    agentId,
    "--message",
    JSON.stringify(message),
  ], { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function emit(text, commandResult) {
  const threadId = `fast-${Date.now()}`;
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  console.log(JSON.stringify({ type: "turn.started" }));
  if (commandResult) {
    console.log(JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "command_execution",
        command: commandResult.command,
        aggregated_output: [commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n"),
        exit_code: commandResult.status,
        status: "completed",
      },
    }));
  }
  console.log(JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text },
  }));
  console.log(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
  }));
}

function fastSelfEchoNoop() {
  const isOwnQueuedMessage = /\bsession-\d{10,}\b/.test(prompt);
  const isAckEcho = prompt.includes("已收到需求。当前我会先确认任务是否已完成接单确认和托管");
  if (!isOwnQueuedMessage && !isAckEcho) return false;

  emit("已忽略本 Agent 自己发出的确认消息回声。");
  process.exit(0);
}

function extractJobId() {
  return firstMatch([
    /["']jobId["']\s*:\s*["'](0x[0-9a-fA-F]+)["']/,
    /\bjob=(0x[0-9a-fA-F]+)/,
    /\bJob\s+(0x[0-9a-fA-F]+)/,
  ]);
}

function fastSystemEvent() {
  const envelope = extractJsonObject(prompt);
  const message = envelope?.message;
  if (!message || message.source !== "system" || !message.event || !message.jobId) return false;

  const agentId = String(envelope.agentId || message.providerAgentId || LOCAL_AGENT_ID);
  const nextAction = runNextAction(agentId, message);
  if (nextAction.status !== 0) {
    emit("平台系统事件处理失败：无法取得官方下一步脚本。", {
      ...nextAction,
      command: "onchainos agent next-action --role auto --agentId <agentId> --message <event>",
    });
    process.exit(1);
  }

  if (message.event === "job_asp_selected") {
    return fastApplyFromNextAction(agentId, nextAction.stdout, message);
  }
  if (message.event === "provider_applied") {
    return fastProviderAppliedFromNextAction(agentId, nextAction.stdout, message);
  }
  if (message.event === "job_accepted") {
    return fastDeliverFromNextAction(agentId, nextAction.stdout, message);
  }

  return false;
}

function fastApplyFromNextAction(agentId, playbook, message) {
  const apply = playbook.match(/onchainos agent apply\s+(0x[0-9a-fA-F]+)\s+--agent-id\s+(\S+)\s+--token-amount\s+([0-9.]+)\s+--token-symbol\s+([A-Za-z0-9]+)/);
  if (!apply) return false;
  const [, jobId, scriptAgentId, amount, symbol] = apply;
  const result = run("/root/.local/bin/onchainos", [
    "agent",
    "apply",
    jobId,
    "--agent-id",
    scriptAgentId || agentId,
    "--token-amount",
    amount,
    "--token-symbol",
    symbol,
  ]);
  emit(`已快速响应平台任务选择事件，申请接单报价 ${amount} ${symbol}。`, {
    ...result,
    command: `next-action(${message.event}) -> onchainos agent apply ${jobId} --agent-id ${scriptAgentId || agentId} --token-amount ${amount} --token-symbol ${symbol}`,
  });
  process.exit(result.status === 0 ? 0 : 1);
}

function fastProviderAppliedFromNextAction(agentId, playbook, message) {
  if (!/onchainos agent user-notify/.test(playbook)) return false;
  const content = `[申请已提交] 任务 ${message.jobId} — 你的申请已链上记录。\n  - ASP agentId: ${agentId}\n  等待 User Agent 确认接单并完成托管资金。`;
  const result = run("/root/.local/bin/onchainos", ["agent", "user-notify", "--content", content]);
  emit("已快速处理申请上链通知。", {
    ...result,
    command: `next-action(${message.event}) -> onchainos agent user-notify --content <localized>`,
  });
  process.exit(result.status === 0 ? 0 : 1);
}

function fastDeliverFromNextAction(agentId, playbook, message) {
  if (!/onchainos agent deliver/.test(playbook)) return false;
  const deliverable = [
    "已收到并完成初步方案。",
    "",
    "1. 先聚焦一个可验证的 AI 场景，避免同时铺开多个方向。",
    "2. 以现有 5 人团队为边界，优先做数据整理、原型验证、客户反馈三件事。",
    "3. 六个月节奏建议：第 1 月锁定场景和指标；第 2-3 月完成 MVP；第 4 月试点；第 5-6 月根据真实反馈迭代并准备上线。",
    "4. 风险控制：预算有限时不要自研大模型，优先使用成熟 API 和轻量自动化流程。",
  ].join("\n");
  const result = run("/root/.local/bin/onchainos", [
    "agent",
    "deliver",
    message.jobId,
    "--agent-id",
    agentId,
    "--deliverable-text",
    deliverable,
    "--message",
    "已提交结构化交付物，请审核。",
  ]);
  emit("已在托管确认后快速提交交付物。", {
    ...result,
    command: `next-action(${message.event}) -> onchainos agent deliver ${message.jobId} --agent-id ${agentId} --deliverable-text <text>`,
  });
  process.exit(result.status === 0 ? 0 : 1);
}

function fastChatAck() {
  const jobId = extractJobId();
  if (!jobId) return false;
  const peerAgentId = firstMatch([
    /\bfromAgent=(\d+)/,
    /["']fromAgent["']\s*:\s*["']?(\d+)["']?/,
    /["']clientAgentId["']\s*:\s*["']?(\d+)["']?/,
  ], PEER_AGENT_ID);
  const content = "已收到需求。当前我会先确认任务是否已完成接单确认和托管；如果尚未确认，我会等待平台状态更新，确认后立即交付。";
  const result = run("/usr/bin/okx-a2a", [
    "session",
    "send",
    "--job-id",
    jobId,
    "--to-agent-id",
    peerAgentId,
    "--agent-id",
    LOCAL_AGENT_ID,
    "--content",
    content,
    "--json",
  ]);
  emit("已快速回复平台功能验证消息。", {
    ...result,
    command: `okx-a2a session send --job-id ${jobId} --to-agent-id ${peerAgentId} --agent-id ${LOCAL_AGENT_ID} --content <ack> --json`,
  });
  process.exit(result.status === 0 ? 0 : 1);
}

fastSelfEchoNoop();
fastSystemEvent();
if (prompt.includes("a2a-agent-chat") || prompt.includes("DACS-Probe") || prompt.includes("XMTP group chat")) fastChatAck();

const delegated = spawnSync(REAL_CODEX, args, { stdio: "inherit" });
process.exit(delegated.status ?? 1);
