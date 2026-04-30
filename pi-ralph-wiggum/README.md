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

If an already-queued Ralph prompt arrives after a loop has completed, the agent should reload `.ralph/<name>.state.json` before doing work. If the loop state is `completed`, it should ignore the stale prompt, avoid file edits and task commands, and not call `ralph_done`.

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
| `/swarm status [run]` | Show the run board and cognitive-load score |
| `/swarm agents [run]` | List agents for a run |
| `/swarm pause [run]` | Pause run metadata |
| `/swarm resume [run]` | Resume run metadata |
| `/swarm stop [run]` | Mark the run completed |
| `/swarm summarize [run]` | Show a compact board |

### Swarm agent tools

Agents can use:

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
- `swarm_list_agents`: list run agents with statuses and loop names.
- `swarm_cognitive_load`: return the load score and reasons.
- `swarm_collect`: read a subagent's task-file evidence.
- `swarm_advance_agent`: advance a subagent loop.
- `swarm_pause_agent`: pause a subagent loop without deleting evidence.
- `swarm_cancel_agent`: cancel an agent while preserving its task file.
- `swarm_record_decision`: persist an integration decision.
- `swarm_record_blocker`: persist a blocker and raise load.

### Cognitive load policy

The swarm board scores load from active agents, active writer agents, blocked agents, unresolved blockers, and overlapping owned paths.

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
pi-ralph-swarm status --run metal-pr-review
pi-ralph-swarm collect --agent swarm-metal-pr-review-verifier-1
pi-ralph-swarm doctor --run metal-pr-review --fix
```

Use `pi-ralph-swarm ignore` in a worktree to add `.ralph/` to `.git/info/exclude`. This keeps local swarm state available to agents without risking accidental commits to upstreamable branches.

The CLI intentionally manipulates the same `.ralph/<loop>.md`, `.ralph/<loop>.state.json`, and `.ralph/swarm/*.json` files used by the Pi extension. It does not queue Pi follow-up prompts; it is a local state/control shim for external agents and workflow tests.

Use `pi-ralph-swarm doctor` to detect duplicate or non-canonical local agent state files after manual edits or older CLI runs. Add `--fix` to rewrite canonical records and remove stale duplicates.

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
