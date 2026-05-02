# Ralph Wiggum Extension

Long-running agent loops for iterative development. Best for long-running-tasks that are verifiable. Builds on Geoffrey Huntley's ralph-loop for Claude Code and adapts it for Pi.
This one is cool because:
- You can ask Pi and it will set up and run the loop all by itself in-session. If you prefer, it can also invoke another Pi via tmux
- You can have multiple parallel loops at once in the same repo (unlike OG ralph-wiggum)
- You can ask Pi to self-reflect at regular intervals so it doesn't mindlessly grind through wrong instructions (optional)
- You can use swarm mode to wrap Ralph loops as scoped subagents with a Kimi-style conductor/status-board workflow

<img width="432" height="357" alt="Screenshot 2026-01-07 at 17 16 24" src="https://github.com/user-attachments/assets/68cdab11-76c6-4aed-9ea1-558cbb267ea6" />

**Note: Flat Ralph loops remain the default. Swarm mode adds a lightweight MCP-style control plane on top of Ralph state; the main assistant still acts as conductor/integrator.**

## Installation

```bash
pi install npm:@tmustier/pi-ralph-wiggum
```

```bash
pi install git:github.com/tmustier/pi-extensions
```

Then filter to just this extension in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/tmustier/pi-extensions",
      "extensions": ["pi-ralph-wiggum/index.ts"],
      "skills": ["pi-ralph-wiggum/SKILL.md"]
    }
  ]
}
```

## Recommended usage: just ask Pi
You ask Pi to set up a ralph-wiggum loop.
- Pi sets up `.ralph/<name>.md` with goals and a checklist (like a list of features to build, errors to check, or files to refactor)
- You let Pi know:
  1. What the task is and completion / tests to run
  2. How many items to process per iteration
  3. How often to commit
  4. (optionally) After how many items it should take a step back and self-reflect
- Pi runs `ralph_start`, beginning iteration 1.
  - It gets a prompt telling it to work on the task, update the task file, and call ralph_done when it finishes that iteration
  - When the iteration is done, it calls `ralph_done`, resending the same prompt*
- Pi runs until either:
  - All tasks are done and final verification is externally rerunnable (Pi sends `<promise>COMPLETE</promise>`)
  - Max iterations (default 50)
  - You hit `esc` (pausing the loop)
If you hit `esc`, you can run `/ralph-stop` to clear the loop. Alternatively, just tell Pi to continue to keep going.

## Completion gate

For build/test/refactor tasks, Ralph prompts the agent not to complete based only on checked checklist items. Before sending `<promise>COMPLETE</promise>`, the agent should:

- Preserve any build artifacts, generated files, virtualenvs, or copied libraries required by final verification.
- Record the exact final command, working directory, relevant environment variables, and output summary in the task file.
- Ensure a separate monitor can rerun that command from the same worktree in a fresh shell.
- Mark work blocked or deferred if the final command cannot be made externally rerunnable.

## Stale prompt guard

If an already-queued Ralph prompt arrives after a loop has completed, the agent should reload `.ralph/<name>.state.json` before doing work. If the loop state is `completed`, it should ignore the stale prompt, avoid file edits and task commands, and not call `ralph_done`. To intentionally append more work to a completed loop, use `/ralph resume <name>`, `swarm_continue_agent`, or `pi-ralph-swarm enqueue --continue-completed`; these paths create a new iteration and clear the completed state before delivering a prompt.

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start <name\|path>` | Start a new loop |
| `/ralph resume <name>` | Resume a paused loop |
| `/ralph stop` | Pause current loop |
| `/ralph-stop` | Stop active loop (idle only) |
| `/ralph status` | Show all loops |
| `/ralph list --archived` | Show archived loops |
| `/ralph archive <name>` | Move loop to archive |
| `/ralph clean [--all]` | Clean completed loops |
| `/ralph cancel <name>` | Delete a loop |
| `/ralph nuke [--yes]` | Delete all .ralph data |

## Swarm Mode

Swarm mode stores top-level run and subagent metadata under `.ralph/swarm/` while each subagent is still a normal Ralph loop with a task file and state file. This gives you Kimi-style task decomposition without replacing Ralph's completion gate or stale-prompt guard.

### Swarm commands

| Command | Description |
|---------|-------------|
| `/swarm start <name> <goal>` | Create a swarm run |
| `/swarm status [run]` | Show the run board and orchestrator-load score |
| `/swarm agents [run]` | List agents for a run |
| `/swarm pause [run]` | Pause run metadata |
| `/swarm resume [run]` | Resume run metadata |
| `/swarm stop [run]` | Mark the run completed |
| `/swarm queue [run]` | List queued/delivered prompt records |
| `/swarm ready [run]` | Show dependency-unblocked queued prompts |
| `/swarm prune-queue [run]` | Mark stale queued records as stale |
| `/swarm tasks [run]` | List first-class taskboard records |
| `/swarm next-task [run] [agent]` | Show dependency-unblocked claimable tasks |
| `/swarm claim-task <task> <agent>` | Claim a task with a lease |
| `/swarm drain [run]` | Deliver one queued prompt into Pi/Ralph follow-up |
| `/swarm advise [run]` | Show manager-side advisor recommendations |
| `/swarm escalations [run]` | List open/resolved escalation records |
| `/swarm summarize [run]` | Show a compact board |

### Swarm tools

Managers and agents can use:

```ts
swarm_start({
  name: "metal-pr-review",
  goal: "Resolve PR review comments and verify the Metal path",
  constraints: ["one writer per owned path", "record rerunnable verification"],
  maxAgents: 4,
})

swarm_spawn_agent({
  runId: "metal-pr-review",
  role: "verifier",
  mode: "verifier",
  taskContent: "Run focused tests and report exact failures.",
  allowedPaths: ["testing/python/metal", "src/op"],
  ownedPaths: [],
  itemsPerIteration: 2,
  reflectEvery: 3,
})
```

Additional tools:

- `swarm_status`: return the current board and load score.
- `swarm_advise`: return manager-side recommendations from swarm state without spawning an advisor agent.
- `swarm_list_agents`: list run agents with statuses and loop names.
- `swarm_cognitive_load`: return the load score and reasons.
- `swarm_collect`: read a subagent's task-file evidence.
- `swarm_list_queue`: list CLI-created prompt queue records.
- `swarm_next_ready`: show dependency-unblocked queued prompts and paused agents ready to enqueue.
- `swarm_prune_queue`: mark queued records stale when their agent/loop is terminal or prompt is no longer deliverable.
- `swarm_create_task`: create a first-class taskboard record with dependencies, path ownership, acceptance criteria, verification commands, and greenlight policy.
- `swarm_list_tasks`: list taskboard records.
- `swarm_next_task`: show claimable taskboard records after dependency, lease, and owned-path checks.
- `swarm_claim_task`: atomically claim a task with a lease.
- `swarm_checkpoint_task`: attach a proof-bearing checkpoint and move the task to `running`, `review`, `blocked`, `ready`, or `done`.
- `swarm_drain_queue`: deliver queued prompt records into Pi/Ralph follow-up messages.
- `swarm_advance_agent`: advance a subagent loop.
- `swarm_pause_agent`: pause a subagent loop without deleting evidence.
- `swarm_continue_agent`: append a new iteration to a completed subagent loop and optionally queue the prompt.
- `swarm_cancel_agent`: cancel an agent while preserving its task file.
- `swarm_record_decision`: persist an integration decision.
- `swarm_record_blocker`: persist a blocker and raise load.
- `swarm_escalate`: persist a question or risk for orchestrator review.
- `swarm_list_escalations`: list open or resolved escalation records.
- `swarm_resolve_escalation`: record the orchestrator decision for an escalation.

### Orchestrator load policy

The swarm board scores manager/orchestrator load from active agents, active writer agents, blocked agents, unresolved blockers, open escalations, high-severity escalations, and overlapping owned paths. This is meant to protect the lead integrator's cognitive load, not to measure whether subagents can do more work. The max-agent budget counts non-terminal agents (`queued`, `active`, `paused`, `blocked`) and reports completed/cancelled agents separately as historical evidence, so long-running roadmap boards do not become noisy just because completed scouts accumulated.

- Low: continue normally.
- Medium: prefer one writer plus read-only verifier/scout agents.
- High: stop spawning new writers and consolidate evidence.
- Critical: pause risky spawning; ask for a decision or reduce concurrency.

Recommended pattern:

- Many read-only scouts/verifiers.
- At most one writer per owned path.
- One main integrator with final authority over edits, commits, pushes, and PR updates.
- Verification after integration before completion.

### CLI shim

For non-Pi agents or MCP-style evals, the package also ships a small dependency-free CLI:

```bash
pi-ralph-swarm start --name metal-pr-review --goal "Resolve PR review comments"
pi-ralph-swarm spawn --run metal-pr-review --role verifier --mode verifier --task "Run focused tests"
pi-ralph-swarm spawn-phase --run metal-pr-review --contract roadmap.json --phase review --dry-run
pi-ralph-swarm spawn-phase --run metal-pr-review --contract roadmap.json --phase review --enqueue
pi-ralph-swarm enqueue --agent swarm-metal-pr-review-verifier-1
pi-ralph-swarm enqueue --agent swarm-metal-pr-review-verifier-1 --continue-completed --activate
pi-ralph-swarm queue --run metal-pr-review
pi-ralph-swarm next-ready --run metal-pr-review
pi-ralph-swarm prune-queue --run metal-pr-review --dry-run
pi-ralph-swarm task-create --run metal-pr-review --id fix-docs --lane docs --title "Fix docs drift" --owned docs --acceptance "README is updated" --verify "npm run check" --review-required --worktree-required --worktree ../metal-pr-review-fix-docs
pi-ralph-swarm task-create --run metal-pr-review --id design-fix-docs --lane docs --title "Design docs fix" --parent-blocked-task fix-docs --unblocks fix-docs --acceptance "Unblock plan recorded"
pi-ralph-swarm next-task --run metal-pr-review --agent swarm-metal-pr-review-docs-1
pi-ralph-swarm claim-task --task fix-docs --agent swarm-metal-pr-review-docs-1 --lease-minutes 60
pi-ralph-swarm checkpoint-task --task fix-docs --state NEEDS_REVIEW --agent swarm-metal-pr-review-docs-1 --file docs/README.md --command "npm run check" --result "Docs updated; check passed"
pi-ralph-swarm checkpoint-task --task fix-docs --state DONE --agent swarm-metal-pr-review-reviewer-1 --command "npm run check" --result "Review approved"
pi-ralph-swarm pi-queue --run metal-pr-review
pi-ralph-swarm delegate --run metal-pr-review --limit 1
pi-ralph-swarm advise --run metal-pr-review
pi-ralph-swarm escalate --agent swarm-metal-pr-review-verifier-1 --severity high --question "Tests fail after review patch; should I pause or narrow scope?" --evidence .ralph/swarm-metal-pr-review-verifier-1.md
pi-ralph-swarm escalations --run metal-pr-review --status open
pi-ralph-swarm resolve-escalation --id ESCALATION_ID --decision "Pause writer and collect failing command first"
pi-ralph-swarm status --run metal-pr-review
pi-ralph-swarm continue-agent --agent swarm-metal-pr-review-verifier-1 --activate
pi-ralph-swarm collect --agent swarm-metal-pr-review-verifier-1
pi-ralph-swarm doctor --run metal-pr-review --fix
```

Use `pi-ralph-swarm ignore` in a worktree to add `.ralph/` to `.git/info/exclude`. This keeps local swarm state available to agents without risking accidental commits to upstreamable branches.

### Roadmap contracts

Use `pi-ralph-swarm spawn-phase` when a roadmap phase has a repeatable division of labor. The command reads a dependency-free JSON contract and hydrates the selected phase into ordinary swarm agents. It does not create a new scheduler or phase state; spawned agents are normal Ralph-backed swarm loops.

Example contract:

```json
{
  "schemaVersion": 1,
  "name": "metal-roadmap",
  "phases": [
    {
      "id": "gdn-artifacts",
      "title": "GDN artifact hardening",
      "goal": "Improve benchmark artifact reliability without changing kernels.",
      "setupNotes": ["Use python3 -m pytest, not bare pytest."],
      "verificationEnvironment": ["If this is a fresh worktree, ensure build/lib, build/tvm, and TVM_IMPORT_PYTHON_PATH are available."],
      "agents": [
        {
          "id": "schema-writer",
          "kind": "writer",
          "task": "Add JSON schema checks for raw GDN benchmark artifacts.",
          "ownedPaths": ["benchmark/flashqla_metal/benchmark_gdn_raw_metal.py", "testing/python/metal/test_metal_gdn_benchmark.py"]
        },
        {
          "id": "schema-verifier",
          "kind": "verifier",
          "task": "Verify the artifact schema checks and focused benchmark tests.",
          "allowedPaths": ["benchmark/flashqla_metal", "testing/python/metal"],
          "setupNotes": ["Record any required env vars in the task file before completion."],
          "dependsOn": ["schema-writer"]
        }
      ]
    }
  ]
}
```

Hydrate a phase into an existing active run:

```bash
pi-ralph-swarm spawn-phase --run metal-roadmap --contract roadmap.json --phase gdn-artifacts --dry-run
pi-ralph-swarm spawn-phase --run metal-roadmap --contract roadmap.json --phase gdn-artifacts --enqueue
```

Agent kinds map to existing modes: `scout` -> `read-only`, `writer` -> `writer`, `debugger` -> `writer`, and `verifier` -> `verifier`. Explicit `mode` may still be one of `read-only`, `writer`, `verifier`, or `integrator`. Hydrated agents are paused by default; pass `--enqueue` to create queue records and `--activate` with `--enqueue` when you want Pi/Ralph to pick them up immediately.

Dependency order is enforced at queue-drain time. `dependsOn` entries are resolved to hydrated agent loop ids; queued prompts whose dependencies are not completed stay queued but are reported as blocked by `/swarm ready`, `swarm_next_ready`, and `pi-ralph-swarm next-ready`. This keeps execution lead-controlled while preventing a verifier from draining before its writer completes.

Contracts may include `setupNotes` and `verificationEnvironment` at the contract, phase, or agent level. These notes are copied into generated task files so verifiers can preserve required build artifacts, env vars, submodule paths, or other monitor-rerunnable setup details.

The CLI intentionally manipulates the same `.ralph/<loop>.md`, `.ralph/<loop>.state.json`, and `.ralph/swarm/*.json` files used by the Pi extension. It is a local state/control shim: it can create queue records, but it does not execute prompts itself.

Use `pi-ralph-swarm enqueue` to generate a Ralph-compatible follow-up prompt for an agent. The CLI writes `.ralph/swarm/queue/*.json` and `.prompt.md` records and marks the agent `queued`; Pi/Ralph still owns actual prompt delivery and execution. Queue creation is never reported as completed work. If the loop is already completed, pass `--continue-completed` to append a new iteration intentionally; otherwise completed-loop queue records are rejected to preserve the stale-prompt guard.

Use `pi-ralph-swarm prune-queue` or `swarm_prune_queue` on long-lived boards to mark queued records stale when their agent or loop already completed/cancelled, their queue generation no longer matches, or the prompt file is missing. This is non-destructive; it changes queue status to `stale` and records the reason instead of deleting evidence.

### Taskboard and self-claiming

Taskboard records are the first step toward autonomous self-claiming without giving up lead-controlled safety. They live under `.ralph/swarm/tasks/*.json` and are separate from Ralph loop prompts. A task carries its lane, dependencies, allowed paths, owned paths, acceptance criteria, verification commands, review/worktree policy, greenlight policy, claim lease, and checkpoints.

Task statuses are `backlog`, `ready`, `claimed`, `running`, `review`, `blocked`, `done`, and `stale`. `swarm_next_task` and `pi-ralph-swarm next-task` only report a task claimable when dependencies are `done`, the task is `ready` or has an expired compatible claim, required worktree paths exist, and owned paths do not overlap active `claimed`, `running`, or `review` tasks.

Use `dependsOn` only for prerequisite-success ordering. For work that exists to unblock a blocked parent, use `--parent-blocked-task PARENT --unblocks PARENT` instead. These fields preserve blocker lineage but do not make the child wait for the blocked parent to become `done`.

Claims use a local lock file plus a lease timestamp. If a worker dies, another worker can reclaim after the lease expires. This is deliberately local and boring; it prevents two agents from silently editing the same owned path.

Workers report progress with checkpoints, not free-form success claims:

```text
STATE: DONE | BLOCKED | NEEDS_INPUT | HANDOFF | IN_PROGRESS | NEEDS_REVIEW
FILES_CHANGED: exact paths or none
COMMANDS_RUN: exact commands or none
RESULT: concrete result/proof
BLOCKER: blocker or none
NEXT_ACTION: exact handoff
```

Implementation tasks should be created with `--review-required --worktree-required --worktree PATH`. Review-required tasks cannot checkpoint `DONE` until they are in `review`, and the agent that requested review cannot close the task. A separate verifier/reviewer should move them to `done`. Tasks marked `greenlightRequired` may prepare commits, branches, or PR bodies, but `DONE` also requires an explicit `--greenlit` checkpoint and externally visible or irreversible actions still require human approval.

Inside Pi, use `/swarm queue` or `swarm_list_queue` to inspect those records, then `/swarm drain` or `swarm_drain_queue` to deliver one queued prompt as a Pi/Ralph follow-up. Delivery marks the queue record `delivered`, activates the loop/agent, and refuses stale records whose loop completed, agent was cancelled, or queue generation no longer matches current state.

Outside an interactive Pi session, use `pi-ralph-swarm pi-queue` to verify the local extension can be loaded by the installed `pi` runtime, or `pi-ralph-swarm delegate` to launch a non-interactive Pi/Kimi session that calls `swarm_drain_queue` and continues with the delivered Ralph prompt. The default model is `kimi-coding/kimi-for-coding`; override it with `--model` or `PI_RALPH_SWARM_MODEL`. Use `--dry-run` to print the generated `pi` invocation without executing it. Use `--timeout-ms` or `PI_RALPH_SWARM_TIMEOUT_MS` to bound non-interactive delegate runs.

Use `pi-ralph-swarm doctor` to detect duplicate or non-canonical local agent state files after manual edits or older CLI runs. It also flags legacy terminal advisor-role metadata because advisor behavior is manager-side only. Add `--fix` to rewrite canonical records, remove stale duplicates, and relabel terminal advisor-role metadata to a scout role.

Use `swarm_advise`, `/swarm advise`, or `pi-ralph-swarm advise` as an orchestrator-side diagnostic before spawning more agents or after collecting evidence. Advice is ephemeral and rule-based; it does not create an advisor agent, does not persist decisions, and does not replace the manager's final judgment. Persist the actual decision separately with `swarm_record_decision` or `pi-ralph-swarm decision`.

Use `swarm_escalate` or `pi-ralph-swarm escalate` when a subagent needs orchestrator guidance before continuing. Escalations are stored under `.ralph/swarm/escalations/*.json` with severity, question, context, evidence files, recommended options, and whether an orchestrator decision is required. High-severity escalations block the agent by default and raise swarm load until `swarm_resolve_escalation` or `pi-ralph-swarm resolve-escalation` records the decision.

### Options for start

| Option | Description |
|--------|-------------|
| `--max-iterations N` | Stop after N iterations (default 50) |
| `--items-per-iteration N` | Suggest N items per turn (prompt hint) |
| `--reflect-every N` | Reflect every N iterations |

## Agent Tool

The agent can self-start loops using `ralph_start`:

```
ralph_start({
  name: "refactor-auth",
  taskContent: "# Task\n\n## Checklist\n- [ ] Item 1",
  maxIterations: 50,
  itemsPerIteration: 3,
  reflectEvery: 10
})
```

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.

## Changelog

See `CHANGELOG.md`.
