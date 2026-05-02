# Changelog

## Unreleased

### Added
- Add swarm mode: a lightweight Ralph-backed subagent control plane with `/swarm` commands, `swarm_*` tools, run/agent state under `.ralph/swarm/`, cognitive-load scoring, scoped task files, and decision/blocker recording.
- Add `pi-ralph-swarm`, a dependency-free CLI shim for external agents and MCP-style evals to create, inspect, collect, and locally ignore Ralph swarm state.
- Add `pi-ralph-swarm doctor` to detect and repair duplicate or non-canonical local swarm agent state files.
- Add `pi-ralph-swarm enqueue` to write Pi/Ralph-compatible follow-up prompt queue records without executing external runners.
- Add Pi-side swarm queue listing/draining via `/swarm queue`, `/swarm drain`, `swarm_list_queue`, and `swarm_drain_queue`.
- Add `pi-ralph-swarm queue` for local inspection of queued, delivered, stale, or failed prompt records.
- Add `pi-ralph-swarm pi-queue` and `pi-ralph-swarm delegate` to invoke the local extension through the installed Pi runtime with Kimi coding defaults from non-interactive environments.
- Add durable swarm escalations via `swarm_escalate`, `swarm_list_escalations`, `swarm_resolve_escalation`, and matching `pi-ralph-swarm` CLI commands.
- Add manager-side swarm advice via `swarm_advise`, `/swarm advise`, and `pi-ralph-swarm advise` without introducing advisor agents.
- Add explicit completed-loop continuation via `/ralph resume`, `swarm_continue_agent`, `pi-ralph-swarm continue-agent`, and `pi-ralph-swarm enqueue --continue-completed`.
- Add `pi-ralph-swarm spawn-phase` to hydrate JSON roadmap phase contracts into normal swarm agents.
- Add dependency-ready queue views via `/swarm ready`, `swarm_next_ready`, and `pi-ralph-swarm next-ready`.
- Add phase-contract setup notes and verification environment notes copied into generated task files.
- Add stale queue pruning via `/swarm prune-queue`, `swarm_prune_queue`, and `pi-ralph-swarm prune-queue`.
- Add first-class swarm taskboard records with task creation, claim leases, claimability checks, and proof-bearing checkpoints via `swarm_create_task`, `swarm_list_tasks`, `swarm_next_task`, `swarm_claim_task`, `swarm_checkpoint_task`, and matching CLI commands.
- Add Level 3 taskboard enforcement for implementation work: review-required tasks must pass through `NEEDS_REVIEW`, cannot be closed by the review requester, may require an existing isolated worktree before claim, and greenlight-required tasks need an explicit greenlit checkpoint before `DONE`.
- Add `unblocks` and `parentBlockedTask` taskboard fields so unblock/design work can be traceable to a blocked parent without being blocked by `dependsOn` semantics.
- Add swarm-agent completion evidence metadata, including the initial task-file hash used by proof-gated completion checks.
- Add monitor verification via `swarm_verify_agent` and `pi-ralph-swarm verify-agent`, plus queue delivery attempt audit metadata and optional decision provenance fields.

### Changed
- Add a completion gate to Ralph prompts and skill guidance. Agents are now instructed to preserve required verification artifacts and record an exact monitor-rerunnable final command before emitting `<promise>COMPLETE</promise>`.
- Queue Ralph follow-up messages with `streamingBehavior: "followUp"` to avoid runtime warnings when a loop tool schedules the next iteration while the agent is still processing.
- Add a stale-prompt guard instructing agents to reload loop state and ignore already-completed loops instead of doing duplicate work.
- Bound non-interactive `pi-ralph-swarm delegate` dogfood runs to one Ralph work iteration and add a `--timeout-ms`/`PI_RALPH_SWARM_TIMEOUT_MS` escape hatch.
- Count open escalations in swarm cognitive load; high-severity escalations block agents by default until the orchestrator resolves them.
- Count only non-terminal agents against the swarm max-agent budget so completed/cancelled historical agents do not create noisy budget warnings.
- Centralize advisor-role reservation so terminal `advisor` roles are rejected while scoped roles such as `advisor-scout` remain valid.
- Extend `pi-ralph-swarm doctor` to flag and optionally relabel legacy terminal advisor-role metadata.
- Clarify that swarm load is a manager/orchestrator cognitive-load guardrail, not a measure of subagent capacity.
- Preserve queued agent status when a queued prompt belongs to a paused Ralph loop so swarm boards do not report queued phase agents as merely paused.
- Make swarm queue draining dependency-aware so blocked phase prompts stay queued until prerequisites complete.
- Count owned-path overlap only among non-terminal agents so completed historical writers do not keep closed boards at medium load.
- Report completed swarm runs as closed in advice instead of recommending new work.
- Enforce swarm-agent completion in Pi and `pi-ralph-swarm complete-agent`: new agents must mutate their task file and replace `## Final Verification` placeholders before they can be marked completed.
- Require proof-gated swarm completion to have existing preserved artifacts and a passing monitor rerun for the current task-file hash.

## 0.2.0 - 2026-04-19

### Changed
- **BREAKING:** SKILL.md `name` renamed `ralph-wiggum` → `pi-ralph-wiggum` to match the parent directory (both in the repo and after `pi install npm:@tmustier/pi-ralph-wiggum`). This removes the `[Skill conflicts]` warning pi emitted on every startup, but it also changes the skill's public identifier — explicit invocations must now use `/skill:pi-ralph-wiggum` instead of `/skill:ralph-wiggum`. Thanks to @ishanmalik for reporting ([#12](https://github.com/tmustier/pi-extensions/issues/12)).
- Repo directory renamed `ralph-wiggum/` → `pi-ralph-wiggum/` as part of the same fix. Git-source users referencing `~/pi-extensions/ralph-wiggum/…` in their pi config should update the path to `~/pi-extensions/pi-ralph-wiggum/…`. The npm package name (`@tmustier/pi-ralph-wiggum`) is unchanged.
- Renamed the README's `Install` section to `Installation` so it matches the skill validator's expectations.

## 0.1.7 - 2026-04-19

### Fixed
- Ralph loops no longer silently stop after auto-compaction or `/compact`. On session reload, `currentLoop` is now rehydrated from the on-disk state (most-recently-updated active loop wins on ties), so `ralph_done`, `agent_end`, and `before_agent_start` continue to function. Thanks to @elecnix for the detailed report and proposed fix ([#11](https://github.com/tmustier/pi-extensions/issues/11)).

## 0.1.5 - 2026-02-03

### Added
- Add preview image metadata for the extension listing.

## 0.1.4 - 2026-02-02

### Changed
- **BREAKING:** Updated tool execute signatures for Pi v0.51.0 compatibility (`signal` parameter now comes before `onUpdate`)
- **BREAKING:** Changed `before_agent_start` handler to use `systemPrompt` instead of deprecated `systemPromptAppend` (Pi v0.39.0+)

## 0.1.3 - 2026-01-26
- Added note clarifying this is a flat version without subagents.

## 0.1.1 - 2026-01-25
- Clarified that agents must write the task file themselves (tool does not auto-create it).

## 0.1.0 - 2026-01-13
- Initial release.
