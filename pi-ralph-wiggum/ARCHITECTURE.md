# Ralph Architecture

Ralph has three intended layers. Keep new features attached to the lowest layer that can own them safely.

## Agents

Agents are individual execution units.

- Pi runtime invocation and tool access.
- Optional agent identity or behavior files such as `SOUL.md`.
- Ralph loop state, task file, pacing, stale-prompt guard, completion evidence, and monitor verification.
- Scope controls such as allowed paths, owned paths, setup notes, and dependencies.

Agent-level completion is proof-gated. A swarm agent is complete only when its task file changed, final verification fields are concrete, preserved artifacts exist, and monitor evidence proves the recorded command passed for the current task-file hash.

## Teams

Teams are role-bound groups of agents.

- Agent roster and role boundaries.
- Phase or roadmap contracts that hydrate agents.
- Dependency-ready queue policy.
- Review, handoff, escalation, and decision provenance.

Teams should remain a thin orchestration layer over agents. Contracts create ordinary Ralph-backed agents; they should not become a second scheduler.

## Workspace

Workspace is the top-level coordination layer for one or more teams.

- Shared roadmap and cross-team blockers.
- KPI or health signals that help integration, not vanity metrics.
- Public/private state boundaries.
- Integration, verification, release, and PR posture.

Workspace metrics should protect the lead integrator's cognitive load and confidence. They should not incentivize over-parallelizing agents.

## Consolidation Priorities

- Keep completion integrity logic shared between Pi tools and the CLI.
- Keep workflow state schemas explicit and migration-friendly.
- Prefer fixture-driven smoke tests before adding more roadmap/team features.
- Dogfood with real slices, but keep `.ralph/` state local unless explicitly requested.
