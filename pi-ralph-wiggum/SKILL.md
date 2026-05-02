---
name: pi-ralph-wiggum
description: Long-running iterative development loops with pacing control and verifiable progress. Use when tasks require multiple iterations, many discrete steps, or periodic reflection with clear checkpoints; avoid for simple one-shot tasks or quick fixes.
---

# Ralph Wiggum - Long-Running Development Loops

Use the `ralph_start` tool to begin a loop:

```
ralph_start({
  name: "loop-name",
  taskContent: "# Task\n\n## Goals\n- Goal 1\n\n## Checklist\n- [ ] Item 1\n- [ ] Item 2",
  maxIterations: 50,        // Default: 50
  itemsPerIteration: 3,     // Optional: suggest N items per turn
  reflectEvery: 10          // Optional: reflect every N iterations
})
```

## Swarm Mode

Use the `swarm_start` and `swarm_spawn_agent` tools when the task naturally decomposes into specialist workstreams and you need Kimi-style conductor/subagent UX. Swarm mode wraps Ralph loops as scoped subagents and records run state under `.ralph/swarm/`.

Prefer swarm mode when:

- There are independent research, implementation, verification, or review workstreams.
- More than one role can make progress without touching the same files.
- The main assistant should stay as integrator while subagents gather evidence.
- Cognitive load needs explicit tracking across active agents, blockers, decisions, and owned paths.

Avoid swarm mode when:

- The task is a one-shot fix.
- More parallel agents would create file ownership conflicts.
- There is an unresolved user/product decision that blocks safe decomposition.

Typical sequence:

```
swarm_start({
  name: "metal-pr-review",
  goal: "Resolve PR review comments and verify the Metal path",
  constraints: ["one writer per owned path", "record rerunnable verification"],
  maxAgents: 4
})

swarm_spawn_agent({
  runId: "metal-pr-review",
  role: "verifier",
  mode: "verifier",
  taskContent: "Run the focused Metal tests and report failures with exact commands.",
  allowedPaths: ["testing/python/metal", "src/op"],
  ownedPaths: [],
  itemsPerIteration: 2,
  reflectEvery: 3
})
```

Use `swarm_status` to inspect the board and manager/orchestrator load score. Treat load as a guardrail for the lead integrator's cognitive load, not as a claim that subagents cannot do more work. Use `swarm_advise` as a manager-side diagnostic before spawning more agents or after collecting evidence; it returns ephemeral recommendations and must not be used as an advisor-agent replacement. Use `swarm_list_agents` and `swarm_collect` to read subagent state and task-file evidence. Use `swarm_list_queue` to inspect CLI-created prompt records and `swarm_drain_queue` to deliver one queued prompt into Pi/Ralph follow-up. Use `swarm_continue_agent` when the manager intentionally appends new work to a completed subagent loop; stale completed prompts should still be ignored unless the loop was explicitly continued. Use `swarm_escalate` when an agent needs orchestrator guidance before continuing; high-severity escalations block the agent by default. Use `swarm_list_escalations` and `swarm_resolve_escalation` to review and record orchestrator decisions. Use `swarm_pause_agent` or `swarm_cancel_agent` to reduce load without deleting evidence. Use `swarm_record_decision` and `swarm_record_blocker` when the integrator makes a decision or hits an unresolved blocker.

Outside Pi, use the `pi-ralph-swarm` CLI shim to manipulate the same state files. Run `pi-ralph-swarm ignore` inside a repository before dogfooding swarm state so `.ralph/` is excluded locally via `.git/info/exclude` instead of being committed. The CLI can enqueue prompt records, but Pi/Ralph must drain and execute them; queue creation is not task execution. When the `pi` CLI is available, `pi-ralph-swarm pi-queue` verifies extension runtime tool invocation and `pi-ralph-swarm delegate` launches a non-interactive Pi/Kimi session to call `swarm_drain_queue` and continue with the delivered Ralph prompt.

Use `pi-ralph-swarm spawn-phase --run RUN --contract roadmap.json --phase PHASE` when a roadmap has repeatable phase contracts. A phase contract hydrates scout/writer/debugger/verifier specs into ordinary swarm agents; it does not add a new scheduler and does not execute work by itself. Prefer `--dry-run` first, then `--enqueue` when the lead wants Pi/Ralph to deliver the generated prompts.

Main assistant responsibilities in swarm mode:

- Keep final authority over edits, commits, pushes, and PR updates.
- Keep the advisor role with the manager/orchestrator; do not spawn advisor agents.
- Treat roles that end in `advisor` as reserved manager-side roles; use `swarm_advise` instead.
- Prefer many read-only scout/verifier agents and at most one writer per owned path.
- Pause spawning when load is high or critical.
- Treat high-severity escalations as stop-and-review events before more edits.
- Collect and summarize subagent evidence before acting.
- Run or delegate final verification before completion.
- Keep `.ralph/` local unless the user explicitly asks to commit workflow state.

## Loop Behavior

1. **Write the task file**: Create `.ralph/<name>.md` with the task content. The tool does NOT create this file—you must write it yourself using the Write tool.
2. Work on the task and update the file each iteration.
3. Record verification evidence (commands run, file paths, outputs) in the task file.
4. Call `ralph_done` to proceed to the next iteration. In swarm mode, call it with the explicit loop name from the prompt.
5. Before outputting `<promise>COMPLETE</promise>`, run a final verification command that an external monitor can rerun from the same worktree.
6. Stop when complete or when max iterations is reached (default 50).

## Completion Gate

For build/test/refactor tasks, do not mark complete based only on checked checklist items.

Before emitting `<promise>COMPLETE</promise>`:

- Preserve any build artifacts, generated files, virtualenvs, or environment setup required by the final verification command.
- Record the exact final command, working directory, relevant environment variables, and output summary in the task file.
- Ensure the command can be rerun by a separate monitor in a fresh shell from the same worktree.
- If a test cannot be rerun externally, mark the item blocked or deferred instead of complete.
- If cleanup removes required verification artifacts, recreate them or update the final command before completion.

## Stale Prompt Guard

Before doing any work from a Ralph prompt, reload `.ralph/<name>.state.json`. If the loop state says `"status": "completed"`, do not edit files, do not run task commands, and do not call `ralph_done`. Reply briefly that the stale prompt was ignored because the loop is already completed. The manager can intentionally continue a completed loop with `/ralph resume`, `swarm_continue_agent`, or `pi-ralph-swarm enqueue --continue-completed`; only then should the next prompt be treated as live work.

## User Commands

- `/ralph start <name|path>` - Start a new loop.
- `/ralph resume <name>` - Resume loop.
- `/ralph stop` - Pause loop (when agent idle).
- `/ralph-stop` - Stop active loop (idle only).
- `/ralph status` - Show loops.
- `/ralph list --archived` - Show archived loops.
- `/ralph archive <name>` - Move loop to archive.
- `/ralph clean [--all]` - Clean completed loops.
- `/ralph cancel <name>` - Delete loop.
- `/ralph nuke [--yes]` - Delete all .ralph data.

Press ESC to interrupt streaming, send a normal message to resume, and run `/ralph-stop` when idle to end the loop.

## Task File Format

```markdown
# Task Title

Brief description.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2
- [x] Completed item

## Verification
- Commands run, working directories, relevant environment variables, outputs, and whether artifacts required for reruns were preserved

## Final Verification
- Exact monitor-rerunnable command: `<command>`
- Working directory: `<path>`
- Required preserved artifacts: `<paths>`
- Result: `<output summary>`

## Notes
(Update with progress, decisions, blockers)
```

## Best Practices

1. Write a clear checklist with discrete items.
2. Update checklist and notes as you go.
3. Capture verification evidence for completed items.
4. Reflect when stuck to reassess approach.
5. Preserve the environment needed to rerun final verification.
6. Output the completion marker only when truly done and externally rerunnable.
