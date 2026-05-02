import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const FINAL_VERIFICATION_FIELDS = [
  "Exact monitor-rerunnable command",
  "Working directory",
  "Required preserved artifacts",
  "Result",
];

const FINAL_VERIFICATION_PLACEHOLDERS = new Set(["", "<command>", "<path>", "<paths>", "<output summary>"]);
const NO_ARTIFACT_VALUES = new Set(["none", "n/a", "na", "not needed", "not applicable"]);
const RALPH_DIR = ".ralph";

function sanitize(name) {
  return String(name || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_");
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function taskEvidence(content, recordedAt = new Date().toISOString()) {
  return {
    initialTaskFileHash: sha256(content),
    initialTaskFileSize: Buffer.byteLength(content, "utf8"),
    initialTaskFileRecordedAt: recordedAt,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function finalVerificationValue(content, label) {
  const pattern = new RegExp(`^\\s*-\\s*${escapeRegExp(label)}\\s*:\\s*(.*)\\s*$`, "im");
  const match = content.match(pattern);
  return match ? match[1].trim() : undefined;
}

export function cleanFinalVerificationValue(value) {
  return String(value || "").trim().replace(/^`|`$/g, "").replace(/^[\'"]|[\'"]$/g, "").trim();
}

export function finalVerificationFields(content) {
  const fields = {};
  for (const label of FINAL_VERIFICATION_FIELDS) fields[label] = cleanFinalVerificationValue(finalVerificationValue(content, label));
  return fields;
}

export function parseArtifactPaths(value) {
  const cleaned = cleanFinalVerificationValue(value);
  if (NO_ARTIFACT_VALUES.has(cleaned.toLowerCase())) return [];
  return cleaned
    .split(",")
    .map((item) => cleanFinalVerificationValue(item.trim()))
    .filter((item) => item.length > 0 && !NO_ARTIFACT_VALUES.has(item.toLowerCase()));
}

export function artifactStatuses(workingDirectory, artifactField) {
  return parseArtifactPaths(artifactField).map((artifactPath) => {
    const resolved = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(workingDirectory, artifactPath);
    return { path: artifactPath, exists: fs.existsSync(resolved) };
  });
}

export function validateFinalVerification(content) {
  const reasons = [];
  for (const label of FINAL_VERIFICATION_FIELDS) {
    const value = finalVerificationValue(content, label);
    const cleaned = cleanFinalVerificationValue(value);
    if (value === undefined) {
      reasons.push(`missing Final Verification field: ${label}`);
    } else if (FINAL_VERIFICATION_PLACEHOLDERS.has(cleaned.toLowerCase())) {
      reasons.push(`placeholder Final Verification field: ${label}`);
    }
  }
  return reasons;
}

export function agentTaskFile(cwd, agent) {
  return path.resolve(cwd, agent.taskFile || path.join(RALPH_DIR, `${sanitize(agent.loopName)}.md`));
}

export function validateAgentCompletion(cwd, agent, options = {}) {
  const taskFile = agentTaskFile(cwd, agent);
  if (!fs.existsSync(taskFile)) {
    return { ok: false, reasons: [`task file not found: ${path.relative(cwd, taskFile)}`] };
  }
  const content = fs.readFileSync(taskFile, "utf8");
  const hash = sha256(content);
  const reasons = validateFinalVerification(content);
  const fields = finalVerificationFields(content);
  const workingDirectory = fields["Working directory"];
  if (workingDirectory && !fs.existsSync(workingDirectory)) reasons.push(`Final Verification working directory not found: ${workingDirectory}`);
  const artifacts = workingDirectory ? artifactStatuses(workingDirectory, fields["Required preserved artifacts"]) : [];
  for (const artifact of artifacts.filter((item) => !item.exists)) reasons.push(`required artifact not found: ${artifact.path}`);
  const monitor = agent.completionEvidence?.monitor;
  if (!monitor) reasons.push(options.missingMonitorReason || "missing monitor verification: run verify-agent first");
  else {
    if (!monitor.ok || monitor.exitCode !== 0) reasons.push(`monitor verification failed: exit=${monitor.exitCode}`);
    if (monitor.taskFileHash !== hash) reasons.push("monitor verification is stale for current task file");
    if (monitor.command !== fields["Exact monitor-rerunnable command"]) reasons.push("monitor verification command differs from current Final Verification command");
    if (monitor.workingDirectory !== workingDirectory) reasons.push("monitor verification working directory differs from current Final Verification working directory");
    for (const artifact of monitor.artifacts || []) if (!artifact.exists) reasons.push(`monitor artifact missing: ${artifact.path}`);
  }
  const initialHash = agent.completionEvidence?.initialTaskFileHash;
  if (initialHash && hash === initialHash) reasons.push("task file unchanged since agent creation");
  return { ok: reasons.length === 0, reasons, hash, size: Buffer.byteLength(content, "utf8") };
}

export function recordCompletionCheck(agent, validation, checkedAt = new Date().toISOString()) {
  agent.completionEvidence = {
    ...(agent.completionEvidence || {}),
    completedTaskFileHash: validation.hash,
    completedTaskFileSize: validation.size,
    completionCheckedAt: checkedAt,
    completionGateFailure: validation.ok ? undefined : validation.reasons.join("; "),
  };
  if (validation.ok) delete agent.completionEvidence.completionGateFailure;
}

export function completionGateFailure(agent, validation) {
  return `Completion gate failed for ${agent.id}: ${validation.reasons.join("; ")}`;
}

function tailOutput(value) {
  if (!value) return undefined;
  return value.length > 4000 ? value.slice(value.length - 4000) : value;
}

export function verifyAgent(cwd, agent, timeoutMs = 120000, verifiedAt = new Date().toISOString()) {
  const taskFile = agentTaskFile(cwd, agent);
  if (!fs.existsSync(taskFile)) return { ok: false, text: `Verification failed for ${agent.id}: task file not found: ${path.relative(cwd, taskFile)}` };
  const content = fs.readFileSync(taskFile, "utf8");
  const hash = sha256(content);
  const reasons = validateFinalVerification(content);
  const fields = finalVerificationFields(content);
  const command = fields["Exact monitor-rerunnable command"];
  const workingDirectory = fields["Working directory"];
  if (!workingDirectory || !fs.existsSync(workingDirectory)) reasons.push(`Final Verification working directory not found: ${workingDirectory || "(missing)"}`);
  const artifacts = workingDirectory ? artifactStatuses(workingDirectory, fields["Required preserved artifacts"]) : [];
  for (const artifact of artifacts.filter((item) => !item.exists)) reasons.push(`required artifact not found: ${artifact.path}`);

  let exitCode = null;
  let stdoutTail;
  let stderrTail;
  let errorText;
  if (reasons.length === 0) {
    const result = spawnSync(command, { cwd: workingDirectory, shell: true, encoding: "utf8", timeout: timeoutMs });
    exitCode = result.status;
    stdoutTail = tailOutput(result.stdout);
    stderrTail = tailOutput(result.stderr);
    if (result.error) errorText = result.error.message;
    if (result.error) reasons.push(`monitor command error: ${result.error.message}`);
    if (result.status !== 0) reasons.push(`monitor command failed: exit=${result.status}`);
  }
  const ok = reasons.length === 0;
  agent.completionEvidence = {
    ...(agent.completionEvidence || {}),
    monitor: { verifiedAt, taskFileHash: hash, command, workingDirectory, exitCode, ok, stdoutTail, stderrTail, error: errorText, artifacts },
  };
  return {
    ok,
    text: ok ? `Verified ${agent.id}: ${command}` : `Verification failed for ${agent.id}: ${reasons.join("; ")}`,
  };
}

export function queueAttempt(record, status, reason, promptContent, at = new Date().toISOString()) {
  return {
    at,
    status,
    reason,
    queueGeneration: record.queueGeneration ?? 0,
    promptHash: promptContent ? sha256(promptContent) : undefined,
  };
}
