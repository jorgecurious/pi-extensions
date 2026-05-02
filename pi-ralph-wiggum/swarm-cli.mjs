#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const RALPH_DIR = ".ralph";
const SWARM_DIR = path.join(RALPH_DIR, "swarm");
const COMPLETE_MARKER = "<promise>COMPLETE</promise>";
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PI_MODEL = "kimi-coding/kimi-for-coding";
const SWARM_MODES = new Set(["read-only", "writer", "verifier", "integrator"]);
const TASK_STATUSES = new Set(["backlog", "ready", "claimed", "running", "review", "blocked", "done", "stale"]);
const CHECKPOINT_STATES = new Set(["DONE", "BLOCKED", "NEEDS_INPUT", "HANDOFF", "IN_PROGRESS", "NEEDS_REVIEW"]);
const PHASE_AGENT_KINDS = new Map([
  ["scout", "read-only"],
  ["writer", "writer"],
  ["debugger", "writer"],
  ["verifier", "verifier"],
]);
const FINAL_VERIFICATION_FIELDS = [
  "Exact monitor-rerunnable command",
  "Working directory",
  "Required preserved artifacts",
  "Result",
];
const FINAL_VERIFICATION_PLACEHOLDERS = new Set(["", "<command>", "<path>", "<paths>", "<output summary>"]);

const COMPLETION_GATE = `COMPLETION GATE

Do not output ${COMPLETE_MARKER} based only on checked checklist items.
Before completion:
1. Run a final verification command that an external monitor can rerun from the same worktree in a fresh shell.
2. Record the exact command, working directory, relevant environment variables, and output summary in the task file.
3. Preserve every artifact required by that command, including build directories, generated libraries, virtualenvs, caches, or copied dylibs.
4. If cleanup removes required artifacts, recreate them or update the final command before completing.
5. If the final command cannot be made externally rerunnable, mark the item blocked/deferred instead of complete.`;

const STALE_PROMPT_GUARD = `STALE PROMPT GUARD

Before doing any work from a Ralph prompt, reload the loop state file named in the prompt.
If the state says "status": "completed", do not edit files, do not run task commands, and do not call ralph_done. Reply briefly that the stale prompt was ignored because the loop is already completed.`;

function sanitize(name) {
  return String(name || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_");
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function taskEvidence(content) {
  return {
    initialTaskFileHash: sha256(content),
    initialTaskFileSize: Buffer.byteLength(content, "utf8"),
    initialTaskFileRecordedAt: nowIso(),
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

function validateFinalVerification(content) {
  const reasons = [];
  for (const label of FINAL_VERIFICATION_FIELDS) {
    const value = finalVerificationValue(content, label);
    if (value === undefined) {
      reasons.push(`missing Final Verification field: ${label}`);
    } else if (FINAL_VERIFICATION_PLACEHOLDERS.has(value.toLowerCase())) {
      reasons.push(`placeholder Final Verification field: ${label}`);
    }
  }
  return reasons;
}

function validateAgentCompletion(cwd, agent) {
  const taskFile = path.resolve(cwd, agent.taskFile || path.join(RALPH_DIR, `${sanitize(agent.loopName)}.md`));
  if (!fs.existsSync(taskFile)) {
    return { ok: false, reasons: [`task file not found: ${path.relative(cwd, taskFile)}`] };
  }
  const content = fs.readFileSync(taskFile, "utf8");
  const hash = sha256(content);
  const reasons = validateFinalVerification(content);
  const initialHash = agent.completionEvidence?.initialTaskFileHash;
  if (initialHash && hash === initialHash) reasons.push("task file unchanged since agent creation");
  return { ok: reasons.length === 0, reasons, hash, size: Buffer.byteLength(content, "utf8") };
}

function recordCompletionCheck(agent, validation) {
  agent.completionEvidence = {
    ...(agent.completionEvidence || {}),
    completedTaskFileHash: validation.hash,
    completedTaskFileSize: validation.size,
    completionCheckedAt: nowIso(),
    completionGateFailure: validation.ok ? undefined : validation.reasons.join("; "),
  };
  if (validation.ok) delete agent.completionEvidence.completionGateFailure;
}

function completionGateFailure(agent, validation) {
  return `Completion gate failed for ${agent.id}: ${validation.reasons.join("; ")}`;
}

function runPath(cwd, runId) {
  return path.join(cwd, SWARM_DIR, `${sanitize(runId)}.run.json`);
}

function agentPath(cwd, agentId) {
  return path.join(cwd, SWARM_DIR, `${sanitize(agentId)}.agent.json`);
}

function loopStatePath(cwd, loopName) {
  return path.join(cwd, RALPH_DIR, `${sanitize(loopName)}.state.json`);
}

function loopTaskPath(cwd, loopName) {
  return path.join(cwd, RALPH_DIR, `${sanitize(loopName)}.md`);
}

function queueBase(cwd, agentId, queuedAt) {
  const stamp = queuedAt.replace(/[:.]/g, "-");
  return path.join(cwd, SWARM_DIR, "queue", `${stamp}-${sanitize(agentId)}`);
}

function taskPath(cwd, taskId) {
  return path.join(cwd, SWARM_DIR, "tasks", `${sanitize(taskId)}.json`);
}

function taskLockPath(cwd, taskId) {
  return path.join(cwd, SWARM_DIR, "tasks", `${sanitize(taskId)}.lock`);
}

function escalationPath(cwd, escalationId) {
  return path.join(cwd, SWARM_DIR, "escalations", `${sanitize(escalationId)}.json`);
}

function listFiles(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith(suffix)).sort();
}

function loadRun(cwd, runId) {
  const filePath = runPath(cwd, runId);
  if (!fs.existsSync(filePath)) throw new Error(`Swarm run not found: ${runId}`);
  return readJson(filePath);
}

function loadAgent(cwd, agentId) {
  const filePath = agentPath(cwd, agentId);
  if (!fs.existsSync(filePath)) throw new Error(`Swarm agent not found: ${agentId}`);
  return readJson(filePath);
}

function listRuns(cwd) {
  return listFiles(path.join(cwd, SWARM_DIR), ".run.json").map((file) => readJson(path.join(cwd, SWARM_DIR, file)));
}

function agentTimestamp(agent) {
  return Date.parse(agent.updatedAt || agent.createdAt || "") || 0;
}

function listAgentRecords(cwd) {
  const dir = path.join(cwd, SWARM_DIR);
  return listFiles(dir, ".agent.json").map((file) => ({ file, filePath: path.join(dir, file), agent: readJson(path.join(dir, file)) }));
}

function listQueueRecords(cwd, filters = {}) {
  const dir = path.join(cwd, SWARM_DIR, "queue");
  return listFiles(dir, ".json")
    .map((file) => readJson(path.join(dir, file)))
    .filter((record) => {
      if (filters.runId && record.runId !== sanitize(filters.runId)) return false;
      if (filters.agentId && record.agentId !== sanitize(filters.agentId)) return false;
      if (filters.status && record.status !== filters.status) return false;
      return true;
    })
    .sort((a, b) => String(a.queuedAt || "").localeCompare(String(b.queuedAt || "")));
}

function loadTask(cwd, taskId) {
  const filePath = taskPath(cwd, taskId);
  if (!fs.existsSync(filePath)) throw new Error(`Swarm task not found: ${taskId}`);
  return readJson(filePath);
}

function writeTask(cwd, task) {
  task.id = sanitize(task.id);
  task.updatedAt = nowIso();
  writeJson(taskPath(cwd, task.id), task);
}

function listTasks(cwd, filters = {}) {
  const dir = path.join(cwd, SWARM_DIR, "tasks");
  return listFiles(dir, ".json")
    .map((file) => readJson(path.join(dir, file)))
    .filter((task) => {
      if (filters.runId && task.runId !== sanitize(filters.runId)) return false;
      if (filters.status && task.status !== filters.status) return false;
      if (filters.lane && task.lane !== sanitize(filters.lane)) return false;
      return true;
    })
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.id).localeCompare(String(b.id)));
}

function listEscalationRecords(cwd, filters = {}) {
  const dir = path.join(cwd, SWARM_DIR, "escalations");
  return listFiles(dir, ".json")
    .map((file) => readJson(path.join(dir, file)))
    .filter((record) => {
      if (filters.runId && record.runId !== sanitize(filters.runId)) return false;
      if (filters.agentId && record.agentId !== sanitize(filters.agentId)) return false;
      if (filters.status && record.status !== filters.status) return false;
      return true;
    })
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function listAgents(cwd, runId) {
  const byId = new Map();
  for (const { agent } of listAgentRecords(cwd)) {
    if (runId && agent.runId !== sanitize(runId)) continue;
    const existing = byId.get(agent.id);
    if (!existing || agentTimestamp(agent) > agentTimestamp(existing)) byId.set(agent.id, agent);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function syncAgent(cwd, agent) {
  const stateFile = loopStatePath(cwd, agent.loopName);
  if (!fs.existsSync(stateFile)) return agent;
  const state = readJson(stateFile);
  if (state.status === "completed" && agent.status !== "cancelled" && agent.status !== "completed") {
    const validation = validateAgentCompletion(cwd, agent);
    recordCompletionCheck(agent, validation);
    if (validation.ok) agent.status = "completed";
    else {
      agent.status = "blocked";
      agent.lastSummary = completionGateFailure(agent, validation);
    }
  }
  else if (state.status === "paused" && agent.status !== "blocked" && agent.status !== "cancelled" && agent.status !== "queued") agent.status = "paused";
  else if (state.status === "active" && agent.status !== "blocked" && agent.status !== "cancelled" && agent.status !== "queued") agent.status = "active";
  agent.updatedAt = nowIso();
  writeJson(agentPath(cwd, agent.id), agent);
  return agent;
}

function isAdvisorAgentRole(role) {
  const normalized = sanitize(role || "").toLowerCase();
  const parts = normalized.split(/[-_]+/).filter(Boolean);
  return normalized === "advisor" || parts[parts.length - 1] === "advisor" || normalized.includes("advisor_agent");
}

function continueCompletedLoopState(state, activate) {
  const wasCompleted = state.status === "completed";
  if (wasCompleted) {
    state.iteration = Number(state.iteration || 0) + 1;
    if (state.maxIterations > 0 && state.iteration > state.maxIterations) state.maxIterations = state.iteration;
    delete state.completedAt;
    state.continuedAt = nowIso();
  }
  state.status = activate ? "active" : "paused";
  state.active = activate;
  return wasCompleted;
}

function cognitiveLoad(cwd, run) {
  const agents = listAgents(cwd, run.id).map((agent) => syncAgent(cwd, agent));
  const budgetAgents = agents.filter((agent) => agent.status !== "completed" && agent.status !== "cancelled");
  const activeAgents = agents.filter((agent) => agent.status === "active").length;
  const writerAgents = agents.filter((agent) => agent.status === "active" && agent.mode === "writer").length;
  const blockedAgents = agents.filter((agent) => agent.status === "blocked").length;
  const unresolvedBlockers = (run.blockers || []).filter((blocker) => !blocker.resolvedAt).length;
  const openEscalations = listEscalationRecords(cwd, { runId: run.id, status: "open" });
  const highEscalations = openEscalations.filter((record) => record.severity === "high").length;
  const owners = new Map();
  for (const agent of budgetAgents) {
    for (const ownerPath of agent.ownedPaths || []) {
      owners.set(ownerPath, [...(owners.get(ownerPath) || []), agent.id]);
    }
  }
  const overlaps = [...owners.values()].filter((value) => value.length > 1).length;
  let score = activeAgents + writerAgents * 2 + blockedAgents * 2 + unresolvedBlockers * 2 + openEscalations.length * 2 + highEscalations * 2 + overlaps * 2;
  if (budgetAgents.length > (run.maxAgents || 4)) score += budgetAgents.length - (run.maxAgents || 4);
  let level = "low";
  if (score >= 10) level = "critical";
  else if (score >= 7) level = "high";
  else if (score >= 4) level = "medium";
  const reasons = [];
  if (activeAgents > 0) reasons.push(`${activeAgents} active agent(s)`);
  if (writerAgents > 1) reasons.push(`${writerAgents} active writer agent(s)`);
  if (blockedAgents > 0) reasons.push(`${blockedAgents} blocked agent(s)`);
  if (unresolvedBlockers > 0) reasons.push(`${unresolvedBlockers} unresolved blocker(s)`);
  if (openEscalations.length > 0) reasons.push(`${openEscalations.length} open escalation(s)`);
  if (highEscalations > 0) reasons.push(`${highEscalations} high escalation(s)`);
  if (overlaps > 0) reasons.push(`${overlaps} overlapping owned path(s)`);
  if (budgetAgents.length > (run.maxAgents || 4)) reasons.push(`${budgetAgents.length}/${run.maxAgents || 4} non-terminal agent budget exceeded`);
  if (reasons.length === 0) reasons.push("within budget");
  return { level, score, reasons, activeAgents, writerAgents, blockedAgents, budgetAgents: budgetAgents.length, totalAgents: agents.length };
}

function ownedPathOverlaps(agents) {
  const owners = new Map();
  for (const agent of agents.filter((candidate) => candidate.status !== "completed" && candidate.status !== "cancelled")) {
    for (const ownerPath of agent.ownedPaths || []) {
      owners.set(ownerPath, [...(owners.get(ownerPath) || []), agent.id]);
    }
  }
  return [...owners.entries()].filter(([, value]) => value.length > 1);
}

function pathsOverlap(a = [], b = []) {
  return a.some((left) => b.some((right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
}

function taskBlocksOwnedPath(task, now = Date.now()) {
  if (task.status === "running" || task.status === "review") return true;
  return task.status === "claimed" && (Date.parse(task.claimLeaseUntil || "") || 0) > now;
}

function taskDependencyReport(cwd, runId, task) {
  const byId = new Map(listTasks(cwd, { runId }).map((candidate) => [sanitize(candidate.id), candidate]));
  const waiting = [];
  const satisfied = [];
  for (const dependency of task.dependencies || []) {
    const dependencyTask = byId.get(sanitize(dependency));
    if (dependencyTask?.status === "done") satisfied.push(dependencyTask.id);
    else waiting.push(`${dependency}${dependencyTask ? ` (${dependencyTask.status})` : " (missing)"}`);
  }
  return { ready: waiting.length === 0, waiting, satisfied };
}

function taskClaimBlockers(cwd, runId, task, claimantId) {
  const blockers = [];
  try {
    const run = loadRun(cwd, runId);
    if (run.status !== "active") blockers.push(`run is ${run.status}`);
  } catch {
    blockers.push(`run not found: ${runId}`);
  }
  const dependencyReport = taskDependencyReport(cwd, runId, task);
  if (!dependencyReport.ready) blockers.push(`waiting for ${dependencyReport.waiting.join(", ")}`);
  if (task.worktreeRequired) {
    if (!task.worktreePath) blockers.push("isolated worktree is required but worktreePath is not set");
    else if (!fs.existsSync(path.resolve(cwd, task.worktreePath))) blockers.push(`worktree path does not exist: ${task.worktreePath}`);
  }
  const now = Date.now();
  const leaseUntil = Date.parse(task.claimLeaseUntil || "") || 0;
  if (!["ready", "claimed"].includes(task.status)) blockers.push(`status is ${task.status}`);
  if (task.status === "claimed" && leaseUntil > now && task.claimOwner !== claimantId) blockers.push(`claimed by ${task.claimOwner} until ${task.claimLeaseUntil}`);
  const active = listTasks(cwd, { runId }).filter((candidate) => candidate.id !== task.id && taskBlocksOwnedPath(candidate, now));
  for (const candidate of active) {
    if (pathsOverlap(task.ownedPaths || [], candidate.ownedPaths || [])) blockers.push(`owned path overlap with ${candidate.id}`);
  }
  return blockers;
}

function claimableTasks(cwd, runId, claimantId) {
  return listTasks(cwd, { runId }).filter((task) => taskClaimBlockers(cwd, runId, task, claimantId).length === 0);
}

function renderTasks(tasks) {
  if (tasks.length === 0) return "No swarm tasks.";
  return tasks
    .map((task) => {
      const owner = task.claimOwner ? ` owner=${task.claimOwner}` : "";
      const lease = task.claimLeaseUntil ? ` lease=${task.claimLeaseUntil}` : "";
      const lane = task.lane ? ` lane=${task.lane}` : "";
      const review = task.reviewRequired ? " review-required" : "";
      const worktree = task.worktreeRequired ? ` worktree=${task.worktreePath || "required"}` : "";
      const parent = task.parentBlockedTask ? ` parent=${task.parentBlockedTask}` : "";
      const unblocks = task.unblocks?.length ? ` unblocks=${task.unblocks.join(",")}` : "";
      return `${task.id}: ${task.status}${lane}${owner}${lease}${review}${worktree}${parent}${unblocks} - ${task.title || task.goal || "(untitled)"}`;
    })
    .join("\n");
}

function renderNextTasks(cwd, runId, claimantId) {
  const tasks = listTasks(cwd, { runId });
  const ready = [];
  const blocked = [];
  for (const task of tasks) {
    const blockers = taskClaimBlockers(cwd, runId, task, claimantId);
    if (blockers.length === 0) ready.push(task);
    else if (["ready", "claimed"].includes(task.status)) blocked.push(`${task.id}: ${blockers.join("; ")}`);
  }
  const lines = [`Claimable tasks for ${runId}${claimantId ? ` as ${claimantId}` : ""}:`];
  if (ready.length === 0) lines.push("- none");
  else for (const task of ready) lines.push(`- ${task.id}: ${task.title || task.goal || "(untitled)"}`);
  if (blocked.length > 0) {
    lines.push("Blocked ready tasks:");
    for (const item of blocked) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

function withTaskLock(cwd, taskId, fn) {
  const lockPath = taskLockPath(cwd, taskId);
  ensureDir(lockPath);
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${process.pid}\n${nowIso()}\n`, "utf8");
    return fn();
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Task is locked by another claimant: ${taskId}`);
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      // best effort lock cleanup
    }
  }
}

function advise(cwd, run) {
  const load = cognitiveLoad(cwd, run);
  if (run.status === "completed") {
    return {
      urgency: "low",
      summary: "completed run: no active roadmap work remains.",
      recommendations: ["Start or resume a separate run only if new roadmap work is introduced."],
      load,
    };
  }
  const agents = listAgents(cwd, run.id).map((agent) => syncAgent(cwd, agent));
  const activeAgents = agents.filter((agent) => agent.status === "active");
  const activeWriters = activeAgents.filter((agent) => agent.mode === "writer");
  const activeVerifiers = activeAgents.filter((agent) => agent.mode === "verifier");
  const queued = listQueueRecords(cwd, { runId: run.id, status: "queued" });
  const openEscalations = listEscalationRecords(cwd, { runId: run.id, status: "open" });
  const highEscalations = openEscalations.filter((record) => record.severity === "high");
  const unresolvedBlockers = (run.blockers || []).filter((blocker) => !blocker.resolvedAt);
  const overlaps = ownedPathOverlaps(agents);
  const recommendations = [];

  if (load.level === "critical") recommendations.push("Pause risky spawning and reduce active work before assigning more tasks.");
  if (highEscalations.length > 0) recommendations.push("Resolve high-severity escalations before any new edits.");
  else if (openEscalations.length > 0) recommendations.push("Review open escalations before spawning new agents.");
  if (unresolvedBlockers.length > 0) recommendations.push("Record an orchestrator decision or blocker resolution before continuing implementation.");
  if (activeWriters.length > 1) recommendations.push("Reduce to one active writer or split owned paths before more edits.");
  if (overlaps.length > 0) recommendations.push(`Resolve overlapping ownership: ${overlaps.map(([ownerPath, ids]) => `${ownerPath} (${ids.join(",")})`).join("; ")}.`);
  if (activeWriters.length === 1 && activeVerifiers.length === 0) recommendations.push(`Add or resume a verifier for writer-owned paths: ${(activeWriters[0].ownedPaths || []).join(",") || "unspecified"}.`);
  if (queued.length > 0 && activeAgents.length === 0) recommendations.push("Drain queued prompts or cancel stale queue records before spawning new agents.");
  if (load.level === "low" && recommendations.length === 0) recommendations.push("Load is low; safe next step is a bounded scout/verifier/writer task chosen by the orchestrator.");
  if (recommendations.length === 0) recommendations.push("Consolidate existing evidence before adding more concurrency.");

  return {
    urgency: load.level,
    summary: `${load.level} load: ${recommendations[0]}`,
    recommendations,
    load,
  };
}

function renderAdvice(advice) {
  return [`Advice: ${advice.summary}`, ...advice.recommendations.map((item) => `- ${item}`)].join("\n");
}

function renderBoard(cwd, run) {
  const load = cognitiveLoad(cwd, run);
  const agents = listAgents(cwd, run.id).map((agent) => syncAgent(cwd, agent));
  const queued = listQueueRecords(cwd, { runId: run.id, status: "queued" }).length;
  const ready = readyQueueRecords(cwd, run.id).length;
  const openEscalations = listEscalationRecords(cwd, { runId: run.id, status: "open" }).length;
  const lines = [
    `Swarm: ${run.id} (${run.status})`,
    `Goal: ${run.goal || "(none recorded)"}`,
    `Load: ${load.level} (${load.score}) - ${load.reasons.join(", ")}`,
    `Budget: ${load.budgetAgents}/${run.maxAgents || 4} non-terminal agent(s), ${load.totalAgents} total`,
  ];
  if (queued > 0) lines.push(`Queue: ${queued} queued prompt(s)`);
  if (ready > 0 && ready !== queued) lines.push(`Ready: ${ready} dependency-unblocked queued prompt(s)`);
  if (openEscalations > 0) lines.push(`Escalations: ${openEscalations} open`);
  lines.push(`Advice: ${advise(cwd, run).summary}`);
  if (run.constraints?.length) lines.push(`Constraints: ${run.constraints.join("; ")}`);
  lines.push("Agents:");
  if (agents.length === 0) lines.push("- none");
  for (const agent of agents) {
    const owns = agent.ownedPaths?.length ? ` owns ${agent.ownedPaths.join(",")}` : "";
    lines.push(`- ${agent.id}: ${agent.status}, ${agent.mode}, loop=${agent.loopName}${owns}`);
  }
  const unresolved = (run.blockers || []).filter((blocker) => !blocker.resolvedAt);
  if (unresolved.length) lines.push(`Blockers: ${unresolved.map((blocker) => blocker.text).join("; ")}`);
  return lines.join("\n");
}

function renderEscalations(records) {
  if (records.length === 0) return "No swarm escalations.";
  return records
    .map((record) => {
      const resolved = record.resolvedAt ? ` resolved=${record.resolvedAt}` : "";
      return `${record.id}: ${record.status}, ${record.severity}, agent=${record.agentId}, decision=${record.needsOrchestratorDecision}, created=${record.createdAt}${resolved}\n  Q: ${record.question}`;
    })
    .join("\n");
}

function values(args, flag) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) result.push(args[++i]);
  }
  return result;
}

function value(args, flag, fallback = undefined) {
  const all = values(args, flag);
  return all.length ? all[all.length - 1] : fallback;
}

function has(args, flag) {
  return args.includes(flag);
}

function defaultAgentTask(run, role, task, mode, allowedPaths, ownedPaths, setupNotes = []) {
  const setup = setupNotes.length ? `\n## Setup Notes\n${setupNotes.map((note) => `- ${note}`).join("\n")}\n` : "";
  return `# Swarm Agent: ${role}

## Run
- Swarm: ${run.id}
- Goal: ${run.goal}

## Role
${role}

## Scope
Mode: ${mode}
Allowed paths: ${allowedPaths.length ? allowedPaths.join(", ") : "not specified"}
Owned paths: ${ownedPaths.length ? ownedPaths.join(", ") : "none"}

## Task
${task}
${setup}

## Checklist
- [ ] Inspect relevant context before acting
- [ ] Complete the assigned role-specific work
- [ ] Record evidence, findings, and exact commands
- [ ] Report blockers instead of guessing when scope is unclear

## Verification
- Commands run, working directories, relevant environment variables, outputs, and preserved artifacts

## Final Verification
- Exact monitor-rerunnable command: <command>
- Working directory: <path>
- Required preserved artifacts: <paths>
- Result: <output summary>

## Notes
(Update this as you work)
`;
}

function buildRalphPrompt(state, taskContent, isReflection) {
  const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
  const header = `RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | REFLECTION" : ""}`;
  const parts = [header, "", `## Current Task (from ${state.taskFile})`, "", taskContent, "---"];
  if (isReflection) parts.push("## Reflection Checkpoint", "", state.reflectInstructions || "Reflect on progress, blockers, and next priorities.", "---");
  parts.push("## Stale Prompt Guard", "", STALE_PROMPT_GUARD, "");
  parts.push("## Completion Gate", "", COMPLETION_GATE, "");
  parts.push("## Instructions", "");
  parts.push("This prompt was queued by pi-ralph-swarm for Pi/Ralph follow-up delivery. Do not treat queue creation as task execution.");
  parts.push(`You are in a Ralph loop (iteration ${state.iteration}${maxStr}).`);
  if (state.itemsPerIteration > 0) {
    parts.push(`Process approximately ${state.itemsPerIteration} item(s), update ${state.taskFile}, then call ralph_done unless the completion gate is satisfied.`);
  } else {
    parts.push(`Continue the task, update ${state.taskFile}, then call ralph_done unless the completion gate is satisfied.`);
  }
  parts.push(`When fully complete and the completion gate is satisfied, respond with: ${COMPLETE_MARKER}`);
  return `${parts.join("\n")}\n`;
}

function commandStart(cwd, args) {
  const id = sanitize(value(args, "--name"));
  if (!id) throw new Error("start requires --name <id>");
  const run = {
    id,
    name: value(args, "--name"),
    goal: value(args, "--goal", "Describe the swarm goal."),
    constraints: values(args, "--constraint"),
    status: "active",
    maxAgents: Number(value(args, "--max-agents", "4")),
    agentIds: [],
    decisions: [],
    blockers: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeJson(runPath(cwd, id), run);
  return renderBoard(cwd, run);
}

function createSwarmAgent(cwd, run, options) {
  const role = options.role;
  if (!role) throw new Error("spawn requires --role <role>");
  if (isAdvisorAgentRole(role)) {
    throw new Error("Advisor is manager-side behavior, not a swarm agent role. Use advise instead.");
  }
  const mode = options.mode || "read-only";
  if (!SWARM_MODES.has(mode)) throw new Error(`invalid agent mode: ${mode}`);
  const loopName = sanitize(options.loopName);
  const taskFile = loopTaskPath(cwd, loopName);
  const allowedPaths = options.allowedPaths || [];
  const ownedPaths = options.ownedPaths || [];
  const setupNotes = options.setupNotes || [];
  const task = options.task || "Complete the assigned swarm task.";
  const active = Boolean(options.active);
  if (options.failIfExists) {
    const collisions = [taskFile, loopStatePath(cwd, loopName), agentPath(cwd, loopName)].filter((filePath) => fs.existsSync(filePath));
    if (collisions.length) throw new Error(`swarm agent already exists for ${loopName}: ${collisions.map((filePath) => path.relative(cwd, filePath)).join(", ")}`);
  }

  const taskContent = defaultAgentTask(run, role, task, mode, allowedPaths, ownedPaths, setupNotes);
  ensureDir(taskFile);
  fs.writeFileSync(taskFile, taskContent, "utf8");

  const state = {
    name: loopName,
    taskFile: path.relative(cwd, taskFile),
    iteration: 1,
    maxIterations: Number(options.maxIterations ?? 20),
    itemsPerIteration: Number(options.itemsPerIteration ?? 2),
    reflectEvery: Number(options.reflectEvery ?? 5),
    reflectInstructions: "Pause and reflect on progress, blockers, and whether the approach should change.",
    active,
    status: active ? "active" : "paused",
    startedAt: nowIso(),
    lastReflectionAt: 0,
  };
  writeJson(loopStatePath(cwd, loopName), state);

  const agent = {
    id: loopName,
    runId: run.id,
    role,
    mode,
    loopName,
    taskFile: state.taskFile,
    status: state.status,
    allowedPaths,
    ownedPaths,
    dependencies: options.dependencies || [],
    setupNotes,
    maxIterations: state.maxIterations,
    itemsPerIteration: state.itemsPerIteration,
    reflectEvery: state.reflectEvery,
    completionEvidence: taskEvidence(taskContent),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeJson(agentPath(cwd, agent.id), agent);
  if (!run.agentIds.includes(agent.id)) run.agentIds.push(agent.id);
  run.updatedAt = nowIso();
  writeJson(runPath(cwd, run.id), run);
  return agent;
}

function commandSpawn(cwd, args) {
  const run = loadRun(cwd, value(args, "--run"));
  const role = value(args, "--role");
  const agents = listAgents(cwd, run.id);
  const taskArg = value(args, "--task", "Complete the assigned swarm task.");
  const task = fs.existsSync(taskArg) ? fs.readFileSync(taskArg, "utf8") : taskArg;
  const agent = createSwarmAgent(cwd, run, {
    role,
    loopName: value(args, "--loop", `swarm-${run.id}-${role}-${agents.length + 1}`),
    mode: value(args, "--mode", "read-only"),
    allowedPaths: values(args, "--allowed"),
    ownedPaths: values(args, "--owned"),
    setupNotes: values(args, "--setup-note"),
    task,
    active: !has(args, "--paused"),
    dependencies: values(args, "--depends-on"),
    maxIterations: Number(value(args, "--max-iterations", "20")),
    itemsPerIteration: Number(value(args, "--items-per-iteration", "2")),
    reflectEvery: Number(value(args, "--reflect-every", "5")),
  });
  return `${agent.id}: ${agent.status}\n${renderBoard(cwd, run)}`;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function optionalStringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be an array of strings`);
  return value;
}

function optionalStringList(value, label) {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  return optionalStringArray(value, label);
}

function nonnegativeNumber(value, label, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function loadPhaseContract(contractPath) {
  let contract;
  try {
    contract = readJson(contractPath);
  } catch (error) {
    throw new Error(`Unable to read roadmap contract ${contractPath}: ${error.message}`);
  }
  if (contract.schemaVersion !== 1) throw new Error("roadmap contract schemaVersion must be 1");
  const phases = requireArray(contract.phases, "roadmap contract phases");
  if (phases.length === 0) throw new Error("roadmap contract must contain at least one phase");
  const phaseIds = new Set();
  for (const phase of phases) {
    const id = sanitize(phase.id);
    if (!id) throw new Error("roadmap contract phase id is required");
    if (phaseIds.has(id)) throw new Error(`duplicate roadmap phase id after sanitize: ${id}`);
    phaseIds.add(id);
  }
  return contract;
}

function phaseAgentLoopName(runId, phaseId, agentId) {
  return sanitize(`swarm-${runId}-${phaseId}-${agentId}`);
}

function phaseAgentTask(contract, phase, agent, task) {
  const setupNotes = [
    ...optionalStringList(contract.setupNotes, "contract.setupNotes"),
    ...optionalStringList(phase.setupNotes, `${phase.id}.setupNotes`),
    ...optionalStringList(agent.setupNotes, `${agent.id}.setupNotes`),
  ];
  const verificationEnvironment = [
    ...optionalStringList(contract.verificationEnvironment, "contract.verificationEnvironment"),
    ...optionalStringList(phase.verificationEnvironment, `${phase.id}.verificationEnvironment`),
    ...optionalStringList(agent.verificationEnvironment, `${agent.id}.verificationEnvironment`),
  ];
  return [
    `Roadmap contract: ${contract.name || "unnamed"}`,
    `Phase: ${phase.id}${phase.title ? ` - ${phase.title}` : ""}`,
    phase.goal ? `Phase goal: ${phase.goal}` : undefined,
    `Agent kind: ${agent.kind}`,
    setupNotes.length ? `Setup notes:\n${setupNotes.map((note) => `- ${note}`).join("\n")}` : undefined,
    verificationEnvironment.length ? `Verification environment:\n${verificationEnvironment.map((note) => `- ${note}`).join("\n")}` : undefined,
    "",
    task,
  ]
    .filter(Boolean)
    .join("\n");
}

function dependencyReport(cwd, agents, agent) {
  const byId = new Map();
  for (const candidate of agents) {
    const synced = syncAgent(cwd, candidate);
    byId.set(sanitize(synced.id), synced);
    byId.set(sanitize(synced.loopName), synced);
  }
  const waiting = [];
  const satisfied = [];
  for (const dependency of agent.dependencies || []) {
    const key = sanitize(dependency);
    const dependencyAgent = byId.get(key);
    if (dependencyAgent?.status === "completed") satisfied.push(dependencyAgent.id);
    else waiting.push(`${dependency}${dependencyAgent ? ` (${dependencyAgent.status})` : " (missing)"}`);
  }
  return { ready: waiting.length === 0, waiting, satisfied };
}

function readyQueueRecords(cwd, runId) {
  const agents = listAgents(cwd, runId).map((agent) => syncAgent(cwd, agent));
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return listQueueRecords(cwd, { runId, status: "queued" }).filter((record) => {
    const agent = byId.get(record.agentId);
    return agent && ["queued", "paused"].includes(agent.status) ? dependencyReport(cwd, agents, agent).ready : false;
  });
}

function renderReadyQueue(cwd, runId) {
  const agents = listAgents(cwd, runId).map((agent) => syncAgent(cwd, agent));
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const queued = listQueueRecords(cwd, { runId, status: "queued" });
  const lines = [`Ready queue for ${runId}:`];
  const ready = [];
  const blocked = [];
  for (const record of queued) {
    const agent = byId.get(record.agentId);
    if (!agent) {
      blocked.push(`${record.agentId}: missing agent`);
      continue;
    }
    if (!["queued", "paused"].includes(agent.status)) {
      blocked.push(`${record.agentId}: not runnable (${agent.status})`);
      continue;
    }
    const report = dependencyReport(cwd, agents, agent);
    if (report.ready) ready.push(`${record.agentId}: ${record.id}`);
    else blocked.push(`${record.agentId}: waiting for ${report.waiting.join(", ")}`);
  }
  if (ready.length === 0) lines.push("- none");
  else for (const item of ready) lines.push(`- ${item}`);
  if (blocked.length > 0) {
    lines.push("Blocked queued prompts:");
    for (const item of blocked) lines.push(`- ${item}`);
  }
  const pausedReady = agents.filter((agent) => agent.status === "paused" && dependencyReport(cwd, agents, agent).ready);
  if (pausedReady.length > 0) {
    lines.push("Paused agents ready to enqueue:");
    for (const agent of pausedReady) lines.push(`- ${agent.id}`);
  }
  return lines.join("\n");
}

function planPhaseAgents(cwd, run, contractPath, contract, phaseId) {
  if (run.status !== "active") throw new Error(`swarm run must be active to hydrate a phase: ${run.id} is ${run.status}`);
  const contractDir = path.dirname(contractPath);
  const phase = contract.phases.find((candidate) => sanitize(candidate.id) === sanitize(phaseId));
  if (!phase) throw new Error(`roadmap phase not found: ${phaseId}`);
  const agents = requireArray(phase.agents, `phase ${phase.id} agents`);
  if (agents.length === 0) throw new Error(`roadmap phase has no agents: ${phase.id}`);
  const phaseSanitized = sanitize(phase.id);
  const agentIds = new Set();
  const planned = [];
  for (const agent of agents) {
    const agentId = sanitize(agent.id);
    if (!agentId) throw new Error(`phase ${phase.id} agent id is required`);
    if (agentIds.has(agentId)) throw new Error(`duplicate phase agent id after sanitize: ${agentId}`);
    agentIds.add(agentId);
  }
  for (const agent of agents) {
    const agentId = sanitize(agent.id);
    const kind = String(agent.kind || "");
    if (!PHASE_AGENT_KINDS.has(kind)) throw new Error(`invalid phase agent kind for ${agentId}: ${kind}`);
    const mode = agent.mode || PHASE_AGENT_KINDS.get(kind);
    if (!SWARM_MODES.has(mode)) throw new Error(`invalid phase agent mode for ${agentId}: ${mode}`);
    const role = agent.role || `${phaseSanitized}-${agentId}`;
    if (isAdvisorAgentRole(role)) throw new Error(`phase agent role is reserved for manager-side advice: ${role}`);
    const allowedPaths = optionalStringArray(agent.allowedPaths, `${agentId}.allowedPaths`);
    const ownedPaths = optionalStringArray(agent.ownedPaths, `${agentId}.ownedPaths`);
    const dependsOn = optionalStringArray(agent.dependsOn, `${agentId}.dependsOn`);
    for (const dependency of dependsOn) {
      if (!agentIds.has(sanitize(dependency))) throw new Error(`phase agent ${agentId} depends on unknown agent: ${dependency}`);
    }
    let task = agent.task;
    if (agent.taskFile) {
      if (task) throw new Error(`phase agent ${agentId} must use only one of task or taskFile`);
      const taskPath = path.resolve(contractDir, agent.taskFile);
      if (!fs.existsSync(taskPath)) throw new Error(`phase agent taskFile not found: ${agent.taskFile}`);
      task = fs.readFileSync(taskPath, "utf8");
    }
    if (!task || typeof task !== "string") throw new Error(`phase agent ${agentId} requires task or taskFile`);
    const loopName = phaseAgentLoopName(run.id, phaseSanitized, agentId);
    planned.push({
      id: agentId,
      role,
      kind,
      mode,
      loopName,
      allowedPaths,
      ownedPaths,
      task: phaseAgentTask(contract, phase, agent, task),
      dependencies: dependsOn.map((dependency) => phaseAgentLoopName(run.id, phaseSanitized, sanitize(dependency))),
      maxIterations: nonnegativeNumber(agent.maxIterations, `${agentId}.maxIterations`, 20),
      itemsPerIteration: nonnegativeNumber(agent.itemsPerIteration, `${agentId}.itemsPerIteration`, 2),
      reflectEvery: nonnegativeNumber(agent.reflectEvery, `${agentId}.reflectEvery`, 5),
    });
  }
  const loopIds = new Set();
  for (const plan of planned) {
    if (loopIds.has(plan.loopName)) throw new Error(`duplicate planned loop id: ${plan.loopName}`);
    loopIds.add(plan.loopName);
    const collisions = [loopTaskPath(cwd, plan.loopName), loopStatePath(cwd, plan.loopName), agentPath(cwd, plan.loopName)].filter((filePath) => fs.existsSync(filePath));
    if (collisions.length) throw new Error(`planned phase agent already exists for ${plan.loopName}: ${collisions.map((filePath) => path.relative(cwd, filePath)).join(", ")}`);
  }
  return { phase, planned };
}

function commandSpawnPhase(cwd, args) {
  const run = loadRun(cwd, value(args, "--run"));
  const contractPath = path.resolve(cwd, value(args, "--contract") || "");
  if (!value(args, "--contract")) throw new Error("spawn-phase requires --contract <file>");
  const phaseId = value(args, "--phase");
  if (!phaseId) throw new Error("spawn-phase requires --phase <id>");
  const contract = loadPhaseContract(contractPath);
  const { phase, planned } = planPhaseAgents(cwd, run, contractPath, contract, phaseId);
  const lines = [`Phase ${phase.id}: ${phase.title || "(untitled)"}`, `Planned agents: ${planned.length}`];
  for (const plan of planned) lines.push(`- ${plan.loopName}: ${plan.kind}/${plan.mode}, role=${plan.role}`);
  if (has(args, "--dry-run")) return lines.join("\n");
  const spawned = [];
  for (const plan of planned) {
    const agent = createSwarmAgent(cwd, run, {
      ...plan,
      active: false,
      failIfExists: true,
    });
    spawned.push(agent);
    if (has(args, "--enqueue")) commandEnqueue(cwd, ["--agent", agent.id, ...(has(args, "--activate") ? ["--activate"] : [])]);
  }
  return [...lines, `Spawned agents: ${spawned.map((agent) => agent.id).join(", ")}`, renderBoard(cwd, loadRun(cwd, run.id))].join("\n");
}

function commandRecord(cwd, args, kind) {
  const run = loadRun(cwd, value(args, "--run"));
  const text = value(args, "--text");
  if (!text) throw new Error(`${kind} requires --text <text>`);
  if (kind === "decision") {
    run.decisions.push({ text, rationale: value(args, "--rationale"), createdAt: nowIso() });
  } else {
    run.blockers.push({ text, neededDecision: value(args, "--needed-decision"), createdAt: nowIso() });
  }
  run.updatedAt = nowIso();
  writeJson(runPath(cwd, run.id), run);
  return `${kind} recorded for ${run.id}: ${text}`;
}

function commandAgentStatus(cwd, args, status) {
  const agent = syncAgent(cwd, loadAgent(cwd, value(args, "--agent")));
  if (status === "completed" && agent.status !== "completed") {
    const validation = validateAgentCompletion(cwd, agent);
    recordCompletionCheck(agent, validation);
    if (!validation.ok) {
      agent.status = "blocked";
      agent.lastSummary = completionGateFailure(agent, validation);
      agent.updatedAt = nowIso();
      writeJson(agentPath(cwd, agent.id), agent);
      throw new Error(agent.lastSummary);
    }
  }
  agent.status = status;
  agent.updatedAt = nowIso();
  writeJson(agentPath(cwd, agent.id), agent);
  const stateFile = loopStatePath(cwd, agent.loopName);
  if (fs.existsSync(stateFile)) {
    const state = readJson(stateFile);
    state.status = status === "completed" ? "completed" : "paused";
    state.active = state.status === "active";
    if (status === "completed") state.completedAt = nowIso();
    writeJson(stateFile, state);
  }
  return `${agent.id}: ${status}`;
}

function commandContinueAgent(cwd, args) {
  const agent = syncAgent(cwd, loadAgent(cwd, value(args, "--agent")));
  const stateFile = loopStatePath(cwd, agent.loopName);
  if (!fs.existsSync(stateFile)) throw new Error(`Ralph state not found for ${agent.loopName}`);
  const state = readJson(stateFile);
  const activate = has(args, "--activate");
  const changed = continueCompletedLoopState(state, activate);
  writeJson(stateFile, state);
  agent.status = state.status;
  agent.updatedAt = nowIso();
  writeJson(agentPath(cwd, agent.id), agent);
  return changed
    ? `${agent.id}: continued ${activate ? "active" : "paused"} at iteration ${state.iteration}/${state.maxIterations}`
    : `${agent.id}: ${agent.status} (loop was not completed)`;
}

function commandEnqueue(cwd, args) {
  const agentId = value(args, "--agent");
  if (!agentId) throw new Error("enqueue requires --agent <id>");
  const agent = syncAgent(cwd, loadAgent(cwd, agentId));
  const run = loadRun(cwd, agent.runId);
  const stateFile = loopStatePath(cwd, agent.loopName);
  if (!fs.existsSync(stateFile)) throw new Error(`Ralph state not found for ${agent.loopName}`);
  const state = readJson(stateFile);
  if (state.status === "completed") {
    if (!has(args, "--continue-completed")) {
      throw new Error(`Ralph loop is completed: ${agent.loopName}. Use --continue-completed to append a new iteration.`);
    }
    continueCompletedLoopState(state, has(args, "--activate"));
  }
  if (state.status === "paused" && has(args, "--activate")) {
    state.status = "active";
    state.active = true;
  }
  state.queueGeneration = Number(state.queueGeneration || 0) + 1;
  const taskPath = path.resolve(cwd, state.taskFile || agent.taskFile);
  if (!fs.existsSync(taskPath)) throw new Error(`Ralph task file not found: ${path.relative(cwd, taskPath)}`);
  const isReflection = state.reflectEvery > 0 && (state.iteration - 1) % state.reflectEvery === 0 && state.iteration !== state.lastReflectionAt;
  if (isReflection) state.lastReflectionAt = state.iteration;
  const prompt = buildRalphPrompt(state, fs.readFileSync(taskPath, "utf8"), isReflection);
  const queuedAt = nowIso();
  const base = queueBase(cwd, agent.id, queuedAt);
  const promptPath = `${base}.prompt.md`;
  const recordPath = `${base}.json`;
  ensureDir(promptPath);
  fs.writeFileSync(promptPath, prompt, "utf8");
  writeJson(recordPath, {
    schemaVersion: 1,
    id: path.basename(base),
    runId: run.id,
    agentId: agent.id,
    loopName: agent.loopName,
    status: "queued",
    delivery: "pi-ralph-followup",
    queueGeneration: state.queueGeneration,
    queuedAt,
    promptFile: path.relative(cwd, promptPath),
    stateFile: path.relative(cwd, stateFile),
    taskFile: path.relative(cwd, taskPath),
    note: "Queue record only. Pi/Ralph must deliver this prompt; pi-ralph-swarm did not execute the agent.",
  });
  state.queuedAt = queuedAt;
  state.queueFile = path.relative(cwd, recordPath);
  writeJson(stateFile, state);
  agent.status = "queued";
  agent.lastQueueFile = path.relative(cwd, recordPath);
  agent.updatedAt = queuedAt;
  writeJson(agentPath(cwd, agent.id), agent);
  run.updatedAt = queuedAt;
  writeJson(runPath(cwd, run.id), run);
  return `${agent.id}: queued for Pi/Ralph follow-up\nrecord: ${path.relative(cwd, recordPath)}\nprompt: ${path.relative(cwd, promptPath)}`;
}

function commandQueue(cwd, args) {
  const records = listQueueRecords(cwd, {
    runId: value(args, "--run"),
    agentId: value(args, "--agent"),
    status: value(args, "--status"),
  });
  if (records.length === 0) return "No swarm queue records.";
  return records
    .map((record) => {
      const delivered = record.deliveredAt ? ` delivered=${record.deliveredAt}` : "";
      const failure = record.failureReason ? ` failure=${record.failureReason}` : "";
      return `${record.id}: ${record.status}, agent=${record.agentId}, gen=${record.queueGeneration ?? 0}, queued=${record.queuedAt}${delivered}${failure}`;
    })
    .join("\n");
}

function staleQueueReason(cwd, record) {
  if (record.status !== "queued") return undefined;
  let agent;
  try {
    agent = syncAgent(cwd, loadAgent(cwd, record.agentId));
  } catch {
    return `Agent not found: ${record.agentId}`;
  }
  if (agent.status === "cancelled") return `Agent is cancelled: ${agent.id}`;
  if (agent.status === "completed") return `Agent is completed: ${agent.id}`;
  const stateFile = loopStatePath(cwd, record.loopName);
  if (!fs.existsSync(stateFile)) return `Loop state not found: ${record.loopName}`;
  const state = readJson(stateFile);
  if (state.status === "completed") return `Loop is completed: ${record.loopName}`;
  if ((state.queueGeneration ?? 0) !== record.queueGeneration) return `Queue generation mismatch: state=${state.queueGeneration ?? 0}, record=${record.queueGeneration}`;
  if (!fs.existsSync(path.resolve(cwd, record.promptFile))) return `Prompt file not found: ${record.promptFile}`;
  return undefined;
}

function commandPruneQueue(cwd, args) {
  const records = listQueueRecords(cwd, {
    runId: value(args, "--run"),
    agentId: value(args, "--agent"),
    status: "queued",
  });
  const stale = records
    .map((record) => ({ record, reason: staleQueueReason(cwd, record) }))
    .filter((item) => item.reason);
  if (stale.length === 0) return "No stale queued swarm records found.";
  const dryRun = has(args, "--dry-run");
  const lines = [dryRun ? "Would mark stale queued records:" : "Marked stale queued records:"];
  for (const { record, reason } of stale) {
    if (!dryRun) {
      record.status = "stale";
      record.failureReason = reason;
      writeJson(path.join(cwd, SWARM_DIR, "queue", `${sanitize(record.id)}.json`), record);
    }
    lines.push(`- ${record.id}: agent=${record.agentId}, reason=${reason}`);
  }
  return lines.join("\n");
}

function commandCreateTask(cwd, args) {
  const run = loadRun(cwd, value(args, "--run"));
  if (run.status !== "active") throw new Error(`swarm run must be active to create tasks: ${run.id} is ${run.status}`);
  const title = value(args, "--title") || value(args, "--goal");
  if (!title) throw new Error("task-create requires --title <text> or --goal <text>");
  const createdAt = nowIso();
  const id = sanitize(value(args, "--id") || `${run.id}-${value(args, "--lane", "task")}-${createdAt}`);
  if (fs.existsSync(taskPath(cwd, id))) throw new Error(`swarm task already exists: ${id}`);
  const status = value(args, "--status", "ready");
  if (!TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
  const task = {
    schemaVersion: 1,
    id,
    runId: run.id,
    lane: sanitize(value(args, "--lane", "general")),
    title,
    goal: value(args, "--goal", title),
    status,
    allowedPaths: values(args, "--allowed"),
    ownedPaths: values(args, "--owned"),
    dependencies: values(args, "--depends-on"),
    unblocks: values(args, "--unblocks"),
    parentBlockedTask: value(args, "--parent-blocked-task"),
    acceptanceCriteria: values(args, "--acceptance"),
    verificationCommands: values(args, "--verify"),
    greenlightRequired: has(args, "--greenlight"),
    reviewRequired: has(args, "--review-required") || has(args, "--implementation"),
    worktreeRequired: has(args, "--worktree-required") || has(args, "--implementation"),
    worktreePath: value(args, "--worktree"),
    checkpoints: [],
    createdAt,
    updatedAt: createdAt,
  };
  writeTask(cwd, task);
  return `${task.id}: ${task.status}\n${renderTasks([task])}`;
}

function commandTasks(cwd, args) {
  const tasks = listTasks(cwd, {
    runId: value(args, "--run"),
    status: value(args, "--status"),
    lane: value(args, "--lane"),
  });
  return renderTasks(tasks);
}

function commandNextTask(cwd, args) {
  const runId = value(args, "--run") || listRuns(cwd).find((run) => run.status === "active")?.id;
  if (!runId) return "No swarm runs found.";
  loadRun(cwd, runId);
  return renderNextTasks(cwd, sanitize(runId), value(args, "--agent"));
}

function commandClaimTask(cwd, args) {
  const taskId = value(args, "--task");
  const agentId = sanitize(value(args, "--agent"));
  if (!taskId) throw new Error("claim-task requires --task <id>");
  if (!agentId) throw new Error("claim-task requires --agent <id>");
  return withTaskLock(cwd, taskId, () => {
    const task = loadTask(cwd, taskId);
    const blockers = taskClaimBlockers(cwd, task.runId, task, agentId);
    if (blockers.length > 0) throw new Error(`Task is not claimable: ${task.id}\n- ${blockers.join("\n- ")}`);
    const leaseMinutes = Number(value(args, "--lease-minutes", "60"));
    if (!Number.isFinite(leaseMinutes) || leaseMinutes <= 0) throw new Error("--lease-minutes must be positive");
    task.status = "claimed";
    task.claimOwner = agentId;
    task.claimedAt = nowIso();
    task.claimLeaseUntil = new Date(Date.now() + leaseMinutes * 60 * 1000).toISOString();
    writeTask(cwd, task);
    return `${task.id}: claimed by ${agentId} until ${task.claimLeaseUntil}`;
  });
}

function commandReleaseTask(cwd, args) {
  const taskId = value(args, "--task");
  if (!taskId) throw new Error("release-task requires --task <id>");
  const task = loadTask(cwd, taskId);
  task.status = value(args, "--status", "ready");
  if (!TASK_STATUSES.has(task.status)) throw new Error(`invalid task status: ${task.status}`);
  delete task.claimOwner;
  delete task.claimedAt;
  delete task.claimLeaseUntil;
  writeTask(cwd, task);
  return `${task.id}: released to ${task.status}`;
}

function commandCheckpointTask(cwd, args) {
  const taskId = value(args, "--task");
  const state = value(args, "--state");
  if (!taskId) throw new Error("checkpoint-task requires --task <id>");
  if (!CHECKPOINT_STATES.has(state)) throw new Error("checkpoint-task requires --state DONE|BLOCKED|NEEDS_INPUT|HANDOFF|IN_PROGRESS|NEEDS_REVIEW");
  const task = loadTask(cwd, taskId);
  const agentId = sanitize(value(args, "--agent", task.claimOwner || "unknown"));
  if (state === "DONE" && task.reviewRequired) {
    if (task.status !== "review") throw new Error(`Task requires review before DONE: ${task.id} is ${task.status}`);
    if (task.reviewRequestedBy && task.reviewRequestedBy === agentId) throw new Error(`Review-required task cannot be closed by requester: ${agentId}`);
  }
  if (state === "DONE" && task.greenlightRequired && !has(args, "--greenlit")) throw new Error(`Task requires explicit greenlight before DONE: ${task.id}`);
  const checkpoint = {
    state,
    agentId,
    filesChanged: values(args, "--file"),
    commandsRun: values(args, "--command"),
    result: value(args, "--result"),
    blocker: value(args, "--blocker"),
    nextAction: value(args, "--next-action"),
    greenlit: has(args, "--greenlit"),
    createdAt: nowIso(),
  };
  task.checkpoints = [...(task.checkpoints || []), checkpoint];
  if (state === "DONE") task.status = "done";
  else if (state === "BLOCKED" || state === "NEEDS_INPUT") task.status = "blocked";
  else if (state === "NEEDS_REVIEW") {
    task.status = "review";
    task.reviewRequestedBy = checkpoint.agentId;
    task.reviewRequestedAt = checkpoint.createdAt;
  }
  else if (state === "IN_PROGRESS") task.status = "running";
  else if (state === "HANDOFF") {
    task.status = value(args, "--status", "ready");
    if (!TASK_STATUSES.has(task.status)) throw new Error(`invalid task status: ${task.status}`);
  }
  if (["done", "blocked", "review", "ready"].includes(task.status)) {
    delete task.claimOwner;
    delete task.claimedAt;
    delete task.claimLeaseUntil;
  }
  writeTask(cwd, task);
  return `${task.id}: checkpoint ${state} -> ${task.status}`;
}

function commandNextReady(cwd, args) {
  const runId = value(args, "--run") || listRuns(cwd).find((run) => run.status === "active")?.id;
  if (!runId) return "No swarm runs found.";
  loadRun(cwd, runId);
  return renderReadyQueue(cwd, sanitize(runId));
}

function commandAdvise(cwd, args) {
  const runId = value(args, "--run") || listRuns(cwd).find((run) => run.status === "active")?.id;
  if (!runId) return "No swarm runs found.";
  return renderAdvice(advise(cwd, loadRun(cwd, runId)));
}

function commandEscalate(cwd, args) {
  const agentId = value(args, "--agent");
  const question = value(args, "--question") || value(args, "--text");
  if (!agentId) throw new Error("escalate requires --agent <id>");
  if (!question) throw new Error("escalate requires --question <text>");
  const agent = syncAgent(cwd, loadAgent(cwd, agentId));
  const run = loadRun(cwd, agent.runId);
  const severity = value(args, "--severity", "medium");
  if (!["low", "medium", "high"].includes(severity)) throw new Error("--severity must be low, medium, or high");
  const createdAt = nowIso();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${agent.id}`;
  const record = {
    schemaVersion: 1,
    id,
    runId: run.id,
    agentId: agent.id,
    loopName: agent.loopName,
    status: "open",
    severity,
    question,
    context: value(args, "--context"),
    evidenceFiles: values(args, "--evidence"),
    recommendedOptions: values(args, "--option"),
    needsOrchestratorDecision: !has(args, "--no-decision"),
    createdAt,
  };
  writeJson(escalationPath(cwd, id), record);

  const shouldPause = has(args, "--pause") || (!has(args, "--no-pause") && severity === "high");
  if (shouldPause) {
    const stateFile = loopStatePath(cwd, agent.loopName);
    if (fs.existsSync(stateFile)) {
      const state = readJson(stateFile);
      state.status = "paused";
      state.active = false;
      writeJson(stateFile, state);
    }
    agent.status = severity === "high" ? "blocked" : "paused";
    agent.updatedAt = createdAt;
    writeJson(agentPath(cwd, agent.id), agent);
  }

  if (severity === "high") {
    run.blockers = run.blockers || [];
    run.blockers.push({ text: `Escalation ${id}: ${question}`, neededDecision: record.needsOrchestratorDecision ? "orchestrator decision" : undefined, createdAt });
  }
  run.updatedAt = createdAt;
  writeJson(runPath(cwd, run.id), run);
  return `Escalated ${id}: ${severity}\n${question}`;
}

function commandEscalations(cwd, args) {
  const records = listEscalationRecords(cwd, {
    runId: value(args, "--run"),
    agentId: value(args, "--agent"),
    status: value(args, "--status"),
  });
  return renderEscalations(records);
}

function commandResolveEscalation(cwd, args) {
  const id = value(args, "--id");
  const decision = value(args, "--decision");
  if (!id) throw new Error("resolve-escalation requires --id <id>");
  if (!decision) throw new Error("resolve-escalation requires --decision <text>");
  const filePath = escalationPath(cwd, id);
  if (!fs.existsSync(filePath)) throw new Error(`Escalation not found: ${id}`);
  const record = readJson(filePath);
  record.status = "resolved";
  record.resolvedAt = record.resolvedAt || nowIso();
  record.resolvedBy = "orchestrator";
  record.decision = decision || record.decision;
  record.resolutionNote = value(args, "--note") || record.resolutionNote;
  writeJson(filePath, record);

  const agent = loadAgent(cwd, record.agentId);
  if (agent.status === "blocked") {
    agent.status = "paused";
    agent.updatedAt = record.resolvedAt;
    writeJson(agentPath(cwd, agent.id), agent);
  }

  const run = loadRun(cwd, record.runId);
  for (const blocker of run.blockers || []) {
    if (!blocker.resolvedAt && String(blocker.text || "").startsWith(`Escalation ${record.id}:`)) blocker.resolvedAt = record.resolvedAt;
  }
  run.decisions = run.decisions || [];
  if (decision) run.decisions.push({ text: `Resolved escalation ${record.id}: ${decision}`, rationale: record.resolutionNote, createdAt: record.resolvedAt });
  run.updatedAt = record.resolvedAt;
  writeJson(runPath(cwd, run.id), run);
  return `Resolved escalation ${record.id}: ${decision}`;
}

function piRuntimeOptions(cwd, args, toolName, params, prompt) {
  const piBin = value(args, "--pi", process.env.PI_RALPH_SWARM_PI || "pi");
  const model = value(args, "--model", process.env.PI_RALPH_SWARM_MODEL || DEFAULT_PI_MODEL);
  const extension = path.resolve(cwd, value(args, "--extension", path.join(CLI_DIR, "index.ts")));
  const tools = value(args, "--tools");
  const timeoutMs = Number(value(args, "--timeout-ms", process.env.PI_RALPH_SWARM_TIMEOUT_MS || "0")) || undefined;
  const piArgs = ["--model", model, "--extension", extension];
  if (!has(args, "--session")) piArgs.push("--no-session");
  if (tools) {
    piArgs.push("--tools", tools);
  } else if (toolName === "swarm_list_queue") {
    piArgs.push("--no-builtin-tools", "--tools", toolName);
  } else {
    piArgs.push(
      "--tools",
      [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "ralph_done",
        "swarm_drain_queue",
        "swarm_list_queue",
        "swarm_create_task",
        "swarm_list_tasks",
        "swarm_next_task",
        "swarm_claim_task",
        "swarm_checkpoint_task",
        "swarm_status",
        "swarm_advise",
        "swarm_collect",
        "swarm_record_blocker",
        "swarm_escalate",
        "swarm_list_escalations",
        "swarm_resolve_escalation",
      ].join(","),
    );
  }
  piArgs.push("-p", prompt || `Call ${toolName} exactly once with these JSON parameters: ${JSON.stringify(params)}. Return only the tool text output.`);
  return { piBin, piArgs, timeoutMs };
}

function runPiRuntimeTool(cwd, args, toolName, params, prompt) {
  const { piBin, piArgs, timeoutMs } = piRuntimeOptions(cwd, args, toolName, params, prompt);
  if (has(args, "--dry-run")) return `${piBin} ${piArgs.map((arg) => JSON.stringify(arg)).join(" ")}`;
  const result = spawnSync(piBin, piArgs, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  const output = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pi runtime tool invocation failed with exit code ${result.status}${output ? `\n${output}` : ""}`);
  return output;
}

function commandPiQueue(cwd, args) {
  const params = {
    runId: value(args, "--run"),
    agentId: value(args, "--agent"),
    status: value(args, "--status"),
  };
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
  return runPiRuntimeTool(cwd, args, "swarm_list_queue", params);
}

function commandDelegate(cwd, args) {
  const params = {
    runId: value(args, "--run"),
    agentId: value(args, "--agent"),
    limit: Number(value(args, "--limit", "1")),
  };
  for (const key of Object.keys(params)) if (params[key] === undefined || Number.isNaN(params[key])) delete params[key];
  const prompt = [
    `Call swarm_drain_queue exactly once with these JSON parameters: ${JSON.stringify(params)}.`,
    "If the tool delivers a Ralph follow-up prompt, continue in this same Pi/Kimi session and follow that prompt.",
    "Do at most one Ralph work iteration in this non-interactive delegate invocation.",
    "If you call ralph_done and a new follow-up is queued, do not continue that next iteration in this same invocation; report the queued next step and stop.",
    "Do not report queue creation as completed work. Report final status, evidence, commands run, and blockers.",
  ].join("\n");
  return runPiRuntimeTool(cwd, args, "swarm_drain_queue", params, prompt);
}

function resolveGitDir(cwd) {
  const dotGit = path.join(cwd, ".git");
  if (!fs.existsSync(dotGit)) throw new Error("No .git directory found in current working directory");
  if (fs.statSync(dotGit).isDirectory()) return dotGit;

  const content = fs.readFileSync(dotGit, "utf8").trim();
  const match = content.match(/^gitdir:\s*(.+)$/i);
  if (!match) throw new Error("Unable to resolve .git file in current working directory");
  return path.resolve(cwd, match[1]);
}

function resolveExcludeGitDir(cwd) {
  const gitDir = resolveGitDir(cwd);
  const commonDirFile = path.join(gitDir, "commondir");
  if (!fs.existsSync(commonDirFile)) return gitDir;
  const commonDir = fs.readFileSync(commonDirFile, "utf8").trim();
  return path.resolve(gitDir, commonDir);
}

function commandIgnore(cwd) {
  const gitDir = resolveExcludeGitDir(cwd);
  const exclude = path.join(gitDir, "info", "exclude");
  ensureDir(exclude);
  const content = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (content.split(/\r?\n/).includes(".ralph/")) return ".ralph/ already present in .git/info/exclude";
  fs.writeFileSync(exclude, `${content}${content.endsWith("\n") || content.length === 0 ? "" : "\n"}.ralph/\n`, "utf8");
  return "Added .ralph/ to .git/info/exclude";
}

function commandDoctor(cwd, args) {
  const fix = has(args, "--fix");
  const runId = value(args, "--run");
  const recordsById = new Map();
  for (const record of listAgentRecords(cwd)) {
    if (runId && record.agent.runId !== sanitize(runId)) continue;
    const id = record.agent.id;
    recordsById.set(id, [...(recordsById.get(id) || []), record]);
  }

  const lines = [];
  for (const [id, records] of recordsById.entries()) {
    const canonicalPath = agentPath(cwd, id);
    const nonCanonical = records.filter((record) => path.resolve(record.filePath) !== path.resolve(canonicalPath));
    if (records.length <= 1 && nonCanonical.length === 0) continue;
    const sorted = [...records].sort((a, b) => agentTimestamp(b.agent) - agentTimestamp(a.agent));
    const keep = sorted[0];
    lines.push(`${id}: ${records.length} record(s), canonical=${path.relative(cwd, canonicalPath)}`);
    if (fix) {
      writeJson(canonicalPath, keep.agent);
      for (const record of records) {
        if (path.resolve(record.filePath) !== path.resolve(canonicalPath)) fs.unlinkSync(record.filePath);
      }
    }
  }

  for (const agent of listAgents(cwd, runId)) {
    if (!isAdvisorAgentRole(agent.role)) continue;
    const replacementRole = `${agent.role.replace(/[-_]?advisor$/i, "") || "scout"}-scout`;
    lines.push(`${agent.id}: terminal advisor role metadata (${agent.role}); use manager-side advise instead`);
    if (fix) {
      agent.role = replacementRole;
      agent.updatedAt = nowIso();
      writeJson(agentPath(cwd, agent.id), agent);
    }
  }

  for (const run of listRuns(cwd)) {
    if (runId && run.id !== sanitize(runId)) continue;
    const ids = [...new Set((run.agentIds || []).filter(Boolean))];
    if (ids.length !== (run.agentIds || []).length) {
      lines.push(`${run.id}: duplicate agentIds in run state`);
      if (fix) {
        run.agentIds = ids;
        run.updatedAt = nowIso();
        writeJson(runPath(cwd, run.id), run);
      }
    }
  }

  if (lines.length === 0) return "No swarm state issues found.";
  return `${fix ? "Fixed" : "Found"} swarm state issues:\n${lines.join("\n")}`;
}

function usage() {
  return `Usage: pi-ralph-swarm <command> [options]

Commands:
  start --name ID --goal TEXT [--constraint TEXT] [--max-agents N]
  spawn --run ID --role ROLE [--task TEXT_OR_FILE] [--mode read-only|writer|verifier|integrator] [--allowed PATH] [--owned PATH] [--setup-note TEXT] [--paused]
  spawn-phase --run ID --contract FILE --phase ID [--enqueue] [--activate] [--dry-run]
  status [--run ID]
  agents --run ID
  collect --agent ID
  enqueue --agent ID [--activate] [--continue-completed]
  queue [--run ID] [--agent ID] [--status queued|delivered|stale|failed]
  prune-queue [--run ID] [--agent ID] [--dry-run]
  next-ready [--run ID]
  task-create --run ID --title TEXT [--id ID] [--lane ID] [--owned PATH] [--depends-on TASK] [--unblocks TASK] [--parent-blocked-task TASK] [--acceptance TEXT] [--verify CMD] [--review-required] [--worktree-required] [--worktree PATH] [--greenlight]
  tasks [--run ID] [--status STATUS] [--lane ID]
  next-task [--run ID] [--agent ID]
  claim-task --task ID --agent ID [--lease-minutes N]
  release-task --task ID [--status ready|backlog|blocked|stale]
  checkpoint-task --task ID --state STATE [--agent ID] [--file PATH] [--command CMD] [--result TEXT] [--blocker TEXT] [--next-action TEXT] [--greenlit]
  advise [--run ID]
  pi-queue [--run ID] [--agent ID] [--status queued|delivered|stale|failed] [--model MODEL]
  delegate [--run ID] [--agent ID] [--limit N] [--model MODEL]
  escalate --agent ID --question TEXT [--severity low|medium|high] [--context TEXT] [--evidence PATH] [--option TEXT] [--pause]
  escalations [--run ID] [--agent ID] [--status open|resolved]
  resolve-escalation --id ID --decision TEXT [--note TEXT]
  decision --run ID --text TEXT [--rationale TEXT]
  blocker --run ID --text TEXT [--needed-decision TEXT]
  pause-agent --agent ID
  continue-agent --agent ID [--activate]
  complete-agent --agent ID
  doctor [--run ID] [--fix]
  ignore
`;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const cwd = process.cwd();
  if (!command || command === "help" || command === "--help") return usage();
  if (command === "start") return commandStart(cwd, args);
  if (command === "spawn") return commandSpawn(cwd, args);
  if (command === "spawn-phase") return commandSpawnPhase(cwd, args);
  if (command === "status") {
    const runId = value(args, "--run") || listRuns(cwd).find((run) => run.status === "active")?.id;
    return runId ? renderBoard(cwd, loadRun(cwd, runId)) : "No swarm runs found.";
  }
  if (command === "agents") return listAgents(cwd, value(args, "--run")).map((agent) => syncAgent(cwd, agent)).map((agent) => `${agent.id}: ${agent.status}, ${agent.mode}, loop=${agent.loopName}`).join("\n") || "No agents found.";
  if (command === "collect") {
    const agent = syncAgent(cwd, loadAgent(cwd, value(args, "--agent")));
    return fs.readFileSync(path.join(cwd, agent.taskFile), "utf8");
  }
  if (command === "enqueue") return commandEnqueue(cwd, args);
  if (command === "queue") return commandQueue(cwd, args);
  if (command === "prune-queue") return commandPruneQueue(cwd, args);
  if (command === "next-ready") return commandNextReady(cwd, args);
  if (command === "task-create") return commandCreateTask(cwd, args);
  if (command === "tasks") return commandTasks(cwd, args);
  if (command === "next-task") return commandNextTask(cwd, args);
  if (command === "claim-task") return commandClaimTask(cwd, args);
  if (command === "release-task") return commandReleaseTask(cwd, args);
  if (command === "checkpoint-task") return commandCheckpointTask(cwd, args);
  if (command === "advise") return commandAdvise(cwd, args);
  if (command === "pi-queue") return commandPiQueue(cwd, args);
  if (command === "delegate") return commandDelegate(cwd, args);
  if (command === "escalate") return commandEscalate(cwd, args);
  if (command === "escalations") return commandEscalations(cwd, args);
  if (command === "resolve-escalation") return commandResolveEscalation(cwd, args);
  if (command === "decision") return commandRecord(cwd, args, "decision");
  if (command === "blocker") return commandRecord(cwd, args, "blocker");
  if (command === "pause-agent") return commandAgentStatus(cwd, args, "paused");
  if (command === "continue-agent") return commandContinueAgent(cwd, args);
  if (command === "complete-agent") return commandAgentStatus(cwd, args, "completed");
  if (command === "doctor") return commandDoctor(cwd, args);
  if (command === "ignore") return commandIgnore(cwd);
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

try {
  const output = main();
  if (output) console.log(output);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
