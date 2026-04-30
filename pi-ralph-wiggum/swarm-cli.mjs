#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const RALPH_DIR = ".ralph";
const SWARM_DIR = path.join(RALPH_DIR, "swarm");

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
  if (state.status === "completed" && agent.status !== "cancelled") agent.status = "completed";
  else if (state.status === "paused" && agent.status !== "blocked" && agent.status !== "cancelled") agent.status = "paused";
  else if (state.status === "active" && agent.status !== "blocked" && agent.status !== "cancelled") agent.status = "active";
  agent.updatedAt = nowIso();
  writeJson(agentPath(cwd, agent.id), agent);
  return agent;
}

function cognitiveLoad(cwd, run) {
  const agents = listAgents(cwd, run.id).map((agent) => syncAgent(cwd, agent));
  const activeAgents = agents.filter((agent) => agent.status === "active").length;
  const writerAgents = agents.filter((agent) => agent.status === "active" && agent.mode === "writer").length;
  const blockedAgents = agents.filter((agent) => agent.status === "blocked").length;
  const unresolvedBlockers = (run.blockers || []).filter((blocker) => !blocker.resolvedAt).length;
  const owners = new Map();
  for (const agent of agents) {
    for (const ownerPath of agent.ownedPaths || []) {
      owners.set(ownerPath, [...(owners.get(ownerPath) || []), agent.id]);
    }
  }
  const overlaps = [...owners.values()].filter((value) => value.length > 1).length;
  let score = activeAgents + writerAgents * 2 + blockedAgents * 2 + unresolvedBlockers * 2 + overlaps * 2;
  if (agents.length > (run.maxAgents || 4)) score += agents.length - run.maxAgents;
  let level = "low";
  if (score >= 10) level = "critical";
  else if (score >= 7) level = "high";
  else if (score >= 4) level = "medium";
  const reasons = [];
  if (activeAgents > 0) reasons.push(`${activeAgents} active agent(s)`);
  if (writerAgents > 1) reasons.push(`${writerAgents} active writer agent(s)`);
  if (blockedAgents > 0) reasons.push(`${blockedAgents} blocked agent(s)`);
  if (unresolvedBlockers > 0) reasons.push(`${unresolvedBlockers} unresolved blocker(s)`);
  if (overlaps > 0) reasons.push(`${overlaps} overlapping owned path(s)`);
  if (agents.length > (run.maxAgents || 4)) reasons.push(`${agents.length}/${run.maxAgents || 4} agent budget exceeded`);
  if (reasons.length === 0) reasons.push("within budget");
  return { level, score, reasons, activeAgents, writerAgents, blockedAgents };
}

function renderBoard(cwd, run) {
  const load = cognitiveLoad(cwd, run);
  const agents = listAgents(cwd, run.id).map((agent) => syncAgent(cwd, agent));
  const lines = [
    `Swarm: ${run.id} (${run.status})`,
    `Goal: ${run.goal || "(none recorded)"}`,
    `Load: ${load.level} (${load.score}) - ${load.reasons.join(", ")}`,
  ];
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

function defaultAgentTask(run, role, task, mode, allowedPaths, ownedPaths) {
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

function commandSpawn(cwd, args) {
  const run = loadRun(cwd, value(args, "--run"));
  const role = value(args, "--role");
  if (!role) throw new Error("spawn requires --role <role>");
  const agents = listAgents(cwd, run.id);
  const loopName = sanitize(value(args, "--loop", `swarm-${run.id}-${role}-${agents.length + 1}`));
  const taskFile = loopTaskPath(cwd, loopName);
  const mode = value(args, "--mode", "read-only");
  const allowedPaths = values(args, "--allowed");
  const ownedPaths = values(args, "--owned");
  const taskArg = value(args, "--task", "Complete the assigned swarm task.");
  const task = fs.existsSync(taskArg) ? fs.readFileSync(taskArg, "utf8") : taskArg;
  const active = !has(args, "--paused");

  ensureDir(taskFile);
  fs.writeFileSync(taskFile, defaultAgentTask(run, role, task, mode, allowedPaths, ownedPaths), "utf8");

  const state = {
    name: loopName,
    taskFile: path.relative(cwd, taskFile),
    iteration: 1,
    maxIterations: Number(value(args, "--max-iterations", "20")),
    itemsPerIteration: Number(value(args, "--items-per-iteration", "2")),
    reflectEvery: Number(value(args, "--reflect-every", "5")),
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
    dependencies: values(args, "--depends-on"),
    maxIterations: state.maxIterations,
    itemsPerIteration: state.itemsPerIteration,
    reflectEvery: state.reflectEvery,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeJson(agentPath(cwd, agent.id), agent);
  if (!run.agentIds.includes(agent.id)) run.agentIds.push(agent.id);
  run.updatedAt = nowIso();
  writeJson(runPath(cwd, run.id), run);
  return `${agent.id}: ${agent.status}\n${renderBoard(cwd, run)}`;
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
  spawn --run ID --role ROLE [--task TEXT_OR_FILE] [--mode read-only|writer|verifier|integrator] [--allowed PATH] [--owned PATH] [--paused]
  status [--run ID]
  agents --run ID
  collect --agent ID
  decision --run ID --text TEXT [--rationale TEXT]
  blocker --run ID --text TEXT [--needed-decision TEXT]
  pause-agent --agent ID
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
  if (command === "status") {
    const runId = value(args, "--run") || listRuns(cwd).find((run) => run.status === "active")?.id;
    return runId ? renderBoard(cwd, loadRun(cwd, runId)) : "No swarm runs found.";
  }
  if (command === "agents") return listAgents(cwd, value(args, "--run")).map((agent) => `${agent.id}: ${agent.status}, ${agent.mode}, loop=${agent.loopName}`).join("\n") || "No agents found.";
  if (command === "collect") {
    const agent = syncAgent(cwd, loadAgent(cwd, value(args, "--agent")));
    return fs.readFileSync(path.join(cwd, agent.taskFile), "utf8");
  }
  if (command === "decision") return commandRecord(cwd, args, "decision");
  if (command === "blocker") return commandRecord(cwd, args, "blocker");
  if (command === "pause-agent") return commandAgentStatus(cwd, args, "paused");
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
