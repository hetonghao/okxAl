#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const REAL_CODEX = process.env.OKX_A2A_REAL_CODEX || "/usr/bin/codex";
const LOCAL_AGENT_ID = process.env.OKX_A2A_FAST_AGENT_ID || "3969";
const PEER_AGENT_ID = process.env.OKX_A2A_FAST_PEER_AGENT_ID || "1791";
const DRY_RUN = process.env.OKX_A2A_FAST_DRY_RUN === "1";

const args = process.argv.slice(2);
const prompt = args.at(-1) || "";

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

function extractJobId() {
  return firstMatch([
    /["']jobId["']\s*:\s*["'](0x[0-9a-fA-F]+)["']/,
    /\bjob=(0x[0-9a-fA-F]+)/,
    /\bJob\s+(0x[0-9a-fA-F]+)/,
  ]);
}

function fastApply() {
  const jobId = extractJobId();
  if (!jobId) return false;
  const amount = firstMatch([/["']tokenAmount["']\s*:\s*["']?([0-9.]+)["']?/], "1");
  const symbol = firstMatch([/["']tokenSymbol["']\s*:\s*["']([A-Za-z0-9]+)["']/], "USDT");
  const result = run("/root/.local/bin/onchainos", [
    "agent",
    "apply",
    jobId,
    "--agent-id",
    LOCAL_AGENT_ID,
    "--token-amount",
    amount,
    "--token-symbol",
    symbol,
  ]);
  emit(`已快速响应平台任务选择事件，申请接单报价 ${amount} ${symbol}。`, {
    ...result,
    command: `onchainos agent apply ${jobId} --agent-id ${LOCAL_AGENT_ID} --token-amount ${amount} --token-symbol ${symbol}`,
  });
  process.exit(result.status === 0 ? 0 : 1);
}

function fastProviderApplied() {
  const jobId = extractJobId();
  if (!jobId) return false;
  const content = `[申请已提交] 任务 ${jobId} 的接单申请已链上记录，等待 User Agent 确认接单并完成托管资金。`;
  const result = run("/root/.local/bin/onchainos", ["agent", "user-notify", "--content", content]);
  emit("已快速处理申请上链通知。", {
    ...result,
    command: "onchainos agent user-notify --content <localized>",
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
  const content = "已收到需求。我会先确认任务状态和托管条件；如果任务已完成确认接单，将继续推进正式交付。";
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

if (prompt.includes("job_asp_selected")) fastApply();
if (prompt.includes("provider_applied")) fastProviderApplied();
if (prompt.includes("a2a-agent-chat") || prompt.includes("DACS-Probe") || prompt.includes("XMTP group chat")) fastChatAck();

const delegated = spawnSync(REAL_CODEX, args, { stdio: "inherit" });
process.exit(delegated.status ?? 1);
