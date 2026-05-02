#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "swarm-cli.mjs");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-completion-gate-"));

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (options.expectFailure) {
    if (result.status === 0) throw new Error(`Expected failure: ${args.join(" ")}\n${output}`);
    return output;
  }
  if (result.status !== 0) throw new Error(`Command failed: ${args.join(" ")}\n${output}`);
  return output;
}

function requireIncludes(text, expected) {
  if (!text.includes(expected)) throw new Error(`Expected output to include ${JSON.stringify(expected)}\n${text}`);
}

run(["start", "--name", "monitor", "--goal", "Smoke completion gate"]);
run(["spawn", "--run", "monitor", "--role", "verifier", "--mode", "verifier", "--paused", "--task", "Verify monitor completion gate."]);

const taskFile = path.join(cwd, ".ralph", "swarm-monitor-verifier-1.md");
let task = fs.readFileSync(taskFile, "utf8");
task = task
  .replace("- [ ] Inspect relevant context before acting", "- [x] Inspect relevant context before acting")
  .replace("- [ ] Complete the assigned role-specific work", "- [x] Complete the assigned role-specific work")
  .replace("- [ ] Record evidence, findings, and exact commands", "- [x] Record evidence, findings, and exact commands")
  .replace("- [ ] Report blockers instead of guessing when scope is unclear", "- [x] Report blockers instead of guessing when scope is unclear")
  .replace("- Exact monitor-rerunnable command: <command>", `- Exact monitor-rerunnable command: ${process.execPath} ${cli} status --run monitor`)
  .replace("- Working directory: <path>", `- Working directory: ${cwd}`)
  .replace("- Required preserved artifacts: <paths>", "- Required preserved artifacts: .ralph/swarm/monitor.run.json, missing-artifact.txt")
  .replace("- Result: <output summary>", "- Result: monitor status command reports the smoke run");
fs.writeFileSync(taskFile, task);

requireIncludes(run(["verify-agent", "--agent", "swarm-monitor-verifier-1"], { expectFailure: false }), "Verification failed");
requireIncludes(run(["complete-agent", "--agent", "swarm-monitor-verifier-1"], { expectFailure: true }), "required artifact not found");

fs.writeFileSync(path.join(cwd, "missing-artifact.txt"), "preserved artifact\n");
requireIncludes(run(["verify-agent", "--agent", "swarm-monitor-verifier-1"]), "Verified swarm-monitor-verifier-1");

fs.appendFileSync(taskFile, "\n## Smoke Mutation\nChanged after monitor verification.\n");
requireIncludes(run(["complete-agent", "--agent", "swarm-monitor-verifier-1"], { expectFailure: true }), "monitor verification is stale");

requireIncludes(run(["verify-agent", "--agent", "swarm-monitor-verifier-1"]), "Verified swarm-monitor-verifier-1");
requireIncludes(run(["complete-agent", "--agent", "swarm-monitor-verifier-1"]), "swarm-monitor-verifier-1: completed");

run(["spawn", "--run", "monitor", "--role", "blocked", "--mode", "verifier", "--paused", "--depends-on", "missing-agent", "--task", "Remain dependency-blocked for queue audit smoke."]);
run(["enqueue", "--agent", "swarm-monitor-blocked-2"]);
const blockedStatePath = path.join(cwd, ".ralph", "swarm-monitor-blocked-2.state.json");
const blockedState = JSON.parse(fs.readFileSync(blockedStatePath, "utf8"));
blockedState.status = "completed";
blockedState.completedAt = new Date().toISOString();
fs.writeFileSync(blockedStatePath, `${JSON.stringify(blockedState, null, 2)}\n`);
run(["prune-queue", "--run", "monitor"]);
run(["decision", "--run", "monitor", "--text", "Use monitor verification", "--rationale", "Smoke provenance", "--source", "smoke", "--agent", "swarm-monitor-verifier-1"]);

const queue = run(["queue", "--run", "monitor"]);
requireIncludes(queue, "attempts=1");
const runState = JSON.parse(fs.readFileSync(path.join(cwd, ".ralph", "swarm", "monitor.run.json"), "utf8"));
if (runState.decisions?.[0]?.source !== "smoke") throw new Error("decision provenance was not recorded");

console.log(`completion gate smoke passed: ${cwd}`);
