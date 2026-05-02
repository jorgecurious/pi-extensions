# Ralph Swarm State Schema Notes

These notes describe the durable `.ralph/swarm/` fields that are part of Ralph's workflow contract. State files are JSON and migration should remain backward-compatible.

## Agent Completion Evidence

Stored on `.ralph/swarm/<agent>.agent.json` as `completionEvidence`.

Required at spawn time for new agents:

- `initialTaskFileHash`: SHA-256 of the generated task file.
- `initialTaskFileSize`: task file size in bytes.
- `initialTaskFileRecordedAt`: ISO timestamp.

Set during completion checks:

- `completedTaskFileHash`: SHA-256 at completion check time.
- `completedTaskFileSize`: task file size at completion check time.
- `completionCheckedAt`: ISO timestamp.
- `completionGateFailure`: last failure reason, omitted when the latest check passes.

## Monitor Evidence

Stored under `completionEvidence.monitor` after `swarm_verify_agent` or `pi-ralph-swarm verify-agent`.

- `verifiedAt`: ISO timestamp.
- `taskFileHash`: task file hash verified by the monitor pass.
- `command`: exact command from `## Final Verification`.
- `workingDirectory`: directory used to run the command.
- `exitCode`: process exit code or `null` if execution did not complete.
- `ok`: true only when artifact checks passed and command exited `0`.
- `stdoutTail`: captured stdout tail, capped for state size.
- `stderrTail`: captured stderr tail, capped for state size.
- `error`: process error text, if any.
- `artifacts`: array of `{ path, exists }` checks for required preserved artifacts.

Completion must reject monitor evidence when `taskFileHash`, `command`, or `workingDirectory` no longer matches the current task file.

## Queue Delivery Attempts

Stored on queue records under `deliveryAttempts`.

- `at`: ISO timestamp.
- `status`: attempted outcome, such as `delivered`, `blocked`, `pending`, `stale`, or `failed`.
- `reason`: optional explanation.
- `queueGeneration`: queue generation observed by the attempt.
- `promptHash`: SHA-256 of the prompt file when available.

Queue records are evidence. Prefer marking stale or failed with an attempt record over deleting them.

## Decision Provenance

Swarm run decisions may include provenance fields:

- `source`: origin such as `orchestrator`, `smoke`, `review`, or `user`.
- `agentId`: related agent.
- `taskId`: related taskboard item.
- `queueId`: related queue record.

Older decisions without provenance remain valid.
