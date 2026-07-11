const DIMENSIONS = ["security", "liquidity", "concentration"];
const LOCALES = new Set(["zh-CN", "en-US"]);
const IDENTIFIER = /^[a-zA-Z0-9._:-]+$/;

const ZH = {
  title: "# Crypto Intel Node — 代币风险情报报告",
  summary: "## 执行摘要",
  network: "网络",
  address: "地址",
  riskScore: "风险分数",
  riskLevel: "风险等级",
  confidence: "置信度",
  confidenceMeaning: "证据完整度乘数，不是统计概率",
  scoreVersion: "评分版本",
  overall: "## 总风险",
  overallText: (score, level, focus) => `当前确定性评分为 ${score}/100，等级为${level}。重点维度：${focus ?? "无"}。`,
  dimensions: "## 三个维度",
  score: "分数",
  status: "状态",
  evidence: "证据",
  evidenceTime: "## 证据与时间戳",
  freshness: "## 新鲜度",
  fresh: "新鲜证据",
  stale: "陈旧证据",
  missingConflicts: "## 缺失与冲突",
  missing: "缺失",
  conflicts: "冲突",
  none: "无",
  sources: "来源",
  boundaries: "## 边界说明",
  boundaryText: "本报告只呈现已验证证据及确定性评分，不补充外部事实，也不构成投资建议或代替独立判断。",
  level: { low: "低", medium: "中", high: "高", critical: "极高" },
  state: { fresh: "新鲜", stale: "陈旧", conflicted: "冲突" },
};

const EN = {
  title: "# Crypto Intel Node — Token Risk Intelligence Report",
  summary: "## Executive Summary",
  network: "Network",
  address: "Address",
  riskScore: "Risk score",
  riskLevel: "Risk level",
  confidence: "Confidence",
  confidenceMeaning: "evidence-completeness multiplier, not a statistical probability",
  scoreVersion: "Score version",
  overall: "## Overall Risk",
  overallText: (score, level, focus) => `The deterministic score is ${score}/100 with a ${level} risk level. Focus dimension: ${focus ?? "none"}.`,
  dimensions: "## Three Dimensions",
  score: "Score",
  status: "Status",
  evidence: "Evidence",
  evidenceTime: "## Evidence and Timestamps",
  freshness: "## Freshness",
  fresh: "Fresh evidence",
  stale: "Stale evidence",
  missingConflicts: "## Missing and Conflicts",
  missing: "Missing",
  conflicts: "Conflicts",
  none: "none",
  sources: "sources",
  boundaries: "## Boundaries",
  boundaryText: "This report presents only verified evidence and deterministic scoring. It adds no external facts and is not investment advice or a substitute for independent judgment.",
  level: { low: "low", medium: "medium", high: "high", critical: "critical" },
  state: { fresh: "fresh", stale: "stale", conflicted: "conflicted" },
};

function invalidAssessment() {
  throw new TypeError("assessment is invalid");
}

function parseAssessment(value) {
  if (!value || typeof value !== "object") invalidAssessment();
  if (!IDENTIFIER.test(value.scoreVersion ?? "") || !Number.isInteger(value.score) || value.score < 0 || value.score > 100) invalidAssessment();
  if (!["low", "medium", "high", "critical"].includes(value.level) || !Number.isFinite(value.confidence)) invalidAssessment();
  if (!value.dimensions || !Array.isArray(value.evidence) || value.evidence.length === 0 || !Array.isArray(value.missing) || !Array.isArray(value.conflicts)) invalidAssessment();
  if (value.missing.length > 0) invalidAssessment();

  for (const dimension of DIMENSIONS) {
    const item = value.dimensions[dimension];
    if (!item || !Number.isInteger(item.score) || item.score < 0 || item.score > 100 || !["fresh", "stale", "conflicted"].includes(item.status)) invalidAssessment();
  }

  const evidence = value.evidence.map((item) => {
    if (
      !item || !DIMENSIONS.includes(item.dimension) || !IDENTIFIER.test(item.source ?? "")
      || !IDENTIFIER.test(item.ruleId ?? "") || !Number.isFinite(Date.parse(item.observedAt))
      || !Number.isInteger(item.score) || !["fresh", "stale"].includes(item.status)
    ) invalidAssessment();
    return { ...item };
  }).sort((a, b) => (
    a.dimension.localeCompare(b.dimension)
    || a.source.localeCompare(b.source)
    || a.ruleId.localeCompare(b.ruleId)
    || a.observedAt.localeCompare(b.observedAt)
    || a.score - b.score
  ));

  const conflicts = value.conflicts.map((item) => {
    if (!item || !DIMENSIONS.includes(item.dimension) || !IDENTIFIER.test(item.type ?? "") || !Number.isFinite(item.minimum) || !Number.isFinite(item.maximum) || !Array.isArray(item.sources) || item.sources.some((source) => !IDENTIFIER.test(source))) invalidAssessment();
    return { ...item, sources: [...item.sources].sort() };
  }).sort((a, b) => a.dimension.localeCompare(b.dimension));

  return { ...value, evidence, conflicts };
}

function orderedDimensions(focus) {
  return [...DIMENSIONS].sort((a, b) => Number(b === focus) - Number(a === focus) || a.localeCompare(b));
}

export function generateRiskReport({ network, address, assessment: rawAssessment, locale = "zh-CN", focus } = {}) {
  if (!LOCALES.has(locale)) throw new TypeError("locale is invalid");
  if (focus !== undefined && !DIMENSIONS.includes(focus)) throw new TypeError("focus is invalid");
  if (!/^eip155:\d+$/.test(network ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new TypeError("asset is invalid");

  const assessment = parseAssessment(rawAssessment);
  const text = locale === "en-US" ? EN : ZH;
  const dimensions = orderedDimensions(focus);
  const evidenceIds = new Map(assessment.evidence.map((item, index) => [item, `E${index + 1}`]));
  const lines = [
    text.title, "", text.summary,
    `- ${text.network}：${network}`.replace("Network：", "Network: "),
    `- ${text.address}：${address}`.replace("Address：", "Address: "),
    `- ${text.riskScore}: ${assessment.score}/100`.replace("风险分数: ", "风险分数："),
    `- ${text.riskLevel}: ${text.level[assessment.level]}`.replace("风险等级: ", "风险等级："),
    `- ${text.confidence}: ${assessment.confidence} (${text.confidenceMeaning})`.replace("置信度: ", "置信度：").replace(" (证据", "（证据").replace("概率)", "概率）"),
    `- ${text.scoreVersion}: ${assessment.scoreVersion}`.replace("评分版本: ", "评分版本："),
    "", text.overall, text.overallText(assessment.score, text.level[assessment.level], focus),
    "", text.dimensions,
  ];

  for (const dimension of dimensions) {
    const ids = assessment.evidence.filter((item) => item.dimension === dimension).map((item) => `[${evidenceIds.get(item)}]`).join(" ");
    lines.push(`### ${dimension}`, `- ${text.score}: ${assessment.dimensions[dimension].score}/100`.replace("分数: ", "分数："), `- ${text.status}: ${text.state[assessment.dimensions[dimension].status]}`.replace("状态: ", "状态："), `- ${text.evidence}: ${ids}`.replace("证据: ", "证据："), "");
  }

  lines.push(text.evidenceTime);
  for (const item of assessment.evidence) {
    lines.push(`- [${evidenceIds.get(item)}] dimension=${item.dimension} | ruleId=${item.ruleId} | source=${item.source} | observedAt=${item.observedAt} | score=${item.score} | status=${item.status}`);
  }

  const fresh = [...new Set(assessment.evidence.filter((item) => item.status === "fresh").map((item) => item.dimension))].sort();
  const stale = [...new Set(assessment.evidence.filter((item) => item.status === "stale").map((item) => item.dimension))].sort();
  lines.push("", text.freshness, `- ${text.fresh}: ${fresh.join(", ") || text.none}`.replace("新鲜证据: ", "新鲜证据："), `- ${text.stale}: ${stale.join(", ") || text.none}`.replace("陈旧证据: ", "陈旧证据："));
  lines.push("", text.missingConflicts, `- ${text.missing}: ${assessment.missing.join(", ") || text.none}`.replace("缺失: ", "缺失："));
  if (assessment.conflicts.length === 0) lines.push(`- ${text.conflicts}: ${text.none}`.replace("冲突: ", "冲突："));
  else for (const item of assessment.conflicts) {
    lines.push(locale === "zh-CN"
      ? `- 冲突：${item.dimension}（${item.type}，${item.minimum}–${item.maximum}，来源 ${item.sources.join(", ")}）`
      : `- Conflicts: ${item.dimension} (${item.type}, ${item.minimum}–${item.maximum}, sources ${item.sources.join(", ")})`);
  }
  lines.push("", text.boundaries, text.boundaryText);
  return `${lines.join("\n")}\n`;
}
