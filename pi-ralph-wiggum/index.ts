/**
 * Ralph Wiggum - Long-running agent loops for iterative development.
 * Port of Geoffrey Huntley's approach.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const RALPH_DIR = ".ralph";
const SWARM_DIR = path.join(RALPH_DIR, "swarm");
const COMPLETE_MARKER = "<promise>COMPLETE</promise>";

const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

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

const DEFAULT_COMPLETION_GATE = `COMPLETION GATE

Do not output ${COMPLETE_MARKER} based only on checked checklist items.
Before completion:
1. Run a final verification command that an external monitor can rerun from the same worktree in a fresh shell.
2. Record the exact command, working directory, relevant environment variables, and output summary in the task file.
3. Preserve every artifact required by that command, including build directories, generated libraries, virtualenvs, caches, or copied dylibs.
4. If cleanup removes required artifacts, recreate them or update the final command before completing.
5. If the final command cannot be made externally rerunnable, mark the item blocked/deferred instead of complete.`;

const DEFAULT_STALE_PROMPT_GUARD = `STALE PROMPT GUARD

Before doing any work from a Ralph prompt, reload the loop state file named in the prompt (usually .ralph/<name>.state.json).
If the state says \"status\": \"completed\", do not edit files, do not run task commands, and do not call ralph_done. Reply briefly that the stale prompt was ignored because the loop is already completed.`;

const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Update the task file with your reflection, then continue working.`;

type LoopStatus = "active" | "paused" | "completed";
type SwarmRunStatus = "active" | "paused" | "completed";
type SwarmAgentStatus = "queued" | "active" | "paused" | "blocked" | "completed" | "cancelled";
type SwarmAgentMode = "read-only" | "writer" | "verifier" | "integrator";
type SwarmQueueStatus = "queued" | "delivered" | "stale" | "failed";
type SwarmEscalationSeverity = "low" | "medium" | "high";
type SwarmEscalationStatus = "open" | "resolved";
type CognitiveLoadLevel = "low" | "medium" | "high" | "critical";

interface LoopState {
	name: string;
	taskFile: string;
	iteration: number;
	queueGeneration?: number;
	queueFile?: string;
	queuedAt?: string;
	maxIterations: number;
	itemsPerIteration: number; // Prompt hint only - "process N items per turn"
	reflectEvery: number; // Reflect every N iterations
	reflectInstructions: string;
	active: boolean; // Backwards compat
	status: LoopStatus;
	startedAt: string;
	completedAt?: string;
	continuedAt?: string;
	lastReflectionAt: number; // Last iteration we reflected at
}

interface SwarmDecision {
	text: string;
	rationale?: string;
	createdAt: string;
}

interface SwarmBlocker {
	text: string;
	neededDecision?: string;
	createdAt: string;
	resolvedAt?: string;
}

interface SwarmRun {
	id: string;
	name: string;
	goal: string;
	constraints: string[];
	status: SwarmRunStatus;
	maxAgents: number;
	agentIds: string[];
	decisions: SwarmDecision[];
	blockers: SwarmBlocker[];
	verification?: string;
	createdAt: string;
	updatedAt: string;
}

interface SwarmAgent {
	id: string;
	runId: string;
	role: string;
	mode: SwarmAgentMode;
	loopName: string;
	taskFile: string;
	status: SwarmAgentStatus;
	allowedPaths: string[];
	ownedPaths: string[];
	dependencies: string[];
	maxIterations: number;
	itemsPerIteration: number;
	reflectEvery: number;
	lastSummary?: string;
	lastQueueFile?: string;
	createdAt: string;
	updatedAt: string;
}

interface SwarmQueueRecord {
	schemaVersion: number;
	id: string;
	runId: string;
	agentId: string;
	loopName: string;
	status: SwarmQueueStatus;
	delivery: "pi-ralph-followup";
	queueGeneration: number;
	queuedAt: string;
	deliveredAt?: string;
	deliveredBy?: string;
	failureReason?: string;
	promptFile: string;
	stateFile: string;
	taskFile: string;
	note?: string;
}

interface SwarmEscalationRecord {
	schemaVersion: number;
	id: string;
	runId: string;
	agentId: string;
	loopName: string;
	status: SwarmEscalationStatus;
	severity: SwarmEscalationSeverity;
	question: string;
	context?: string;
	evidenceFiles: string[];
	recommendedOptions: string[];
	needsOrchestratorDecision: boolean;
	createdAt: string;
	resolvedAt?: string;
	resolvedBy?: string;
	decision?: string;
	resolutionNote?: string;
}

interface CognitiveLoadReport {
	level: CognitiveLoadLevel;
	score: number;
	reasons: string[];
	activeAgents: number;
	writerAgents: number;
	blockedAgents: number;
	budgetAgents: number;
	totalAgents: number;
}

interface SwarmAdvice {
	urgency: CognitiveLoadLevel;
	summary: string;
	recommendations: string[];
	load: CognitiveLoadReport;
}

const STATUS_ICONS: Record<LoopStatus, string> = { active: "▶", paused: "⏸", completed: "✓" };
const SWARM_STATUS_ICONS: Record<SwarmRunStatus | SwarmAgentStatus, string> = {
	active: "▶",
	paused: "⏸",
	completed: "✓",
	queued: "…",
	blocked: "!",
	cancelled: "×",
};

export default function (pi: ExtensionAPI) {
	let currentLoop: string | null = null;
	let currentSwarm: string | null = null;

	// --- File helpers ---

	const ralphDir = (ctx: ExtensionContext) => path.resolve(ctx.cwd, RALPH_DIR);
	const archiveDir = (ctx: ExtensionContext) => path.join(ralphDir(ctx), "archive");
	const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
	const isAdvisorAgentRole = (role: string) => {
		const normalized = sanitize(role).toLowerCase();
		const parts = normalized.split(/[-_]+/).filter(Boolean);
		return normalized === "advisor" || parts[parts.length - 1] === "advisor" || normalized.includes("advisor_agent");
	};

	function getPath(ctx: ExtensionContext, name: string, ext: string, archived = false): string {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		return path.join(dir, `${sanitize(name)}${ext}`);
	}

	function ensureDir(filePath: string): void {
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	}

	function tryDelete(filePath: string): void {
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	}

	function tryRead(filePath: string): string | null {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}

	function safeMtimeMs(filePath: string): number {
		try {
			return fs.statSync(filePath).mtimeMs;
		} catch {
			return 0;
		}
	}

	function tryRemoveDir(dirPath: string): boolean {
		try {
			if (fs.existsSync(dirPath)) {
				fs.rmSync(dirPath, { recursive: true, force: true });
			}
			return true;
		} catch {
			return false;
		}
	}

	// --- State management ---

	function migrateState(raw: Partial<LoopState> & { name: string }): LoopState {
		if (!raw.status) raw.status = raw.active ? "active" : "paused";
		raw.active = raw.status === "active";
		// Migrate old field names
		if ("reflectEveryItems" in raw && !raw.reflectEvery) {
			raw.reflectEvery = (raw as any).reflectEveryItems;
		}
		if ("lastReflectionAtItems" in raw && raw.lastReflectionAt === undefined) {
			raw.lastReflectionAt = (raw as any).lastReflectionAtItems;
		}
		return raw as LoopState;
	}

	function loadState(ctx: ExtensionContext, name: string, archived = false): LoopState | null {
		const content = tryRead(getPath(ctx, name, ".state.json", archived));
		return content ? migrateState(JSON.parse(content)) : null;
	}

	function saveState(ctx: ExtensionContext, state: LoopState, archived = false): void {
		state.active = state.status === "active";
		const filePath = getPath(ctx, state.name, ".state.json", archived);
		ensureDir(filePath);
		fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
	}

	function listLoops(ctx: ExtensionContext, archived = false): LoopState[] {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".state.json"))
			.map((f) => {
				const content = tryRead(path.join(dir, f));
				return content ? migrateState(JSON.parse(content)) : null;
			})
			.filter((s): s is LoopState => s !== null);
	}

	// --- Swarm state management ---

	const swarmDir = (ctx: ExtensionContext) => path.resolve(ctx.cwd, SWARM_DIR);
	const swarmQueueDir = (ctx: ExtensionContext) => path.join(swarmDir(ctx), "queue");
	const swarmEscalationDir = (ctx: ExtensionContext) => path.join(swarmDir(ctx), "escalations");
	const swarmRunPath = (ctx: ExtensionContext, runId: string) => path.join(swarmDir(ctx), `${sanitize(runId)}.run.json`);
	const swarmAgentPath = (ctx: ExtensionContext, agentId: string) => path.join(swarmDir(ctx), `${sanitize(agentId)}.agent.json`);
	const swarmQueuePath = (ctx: ExtensionContext, queueId: string) => path.join(swarmQueueDir(ctx), `${sanitize(queueId)}.json`);
	const swarmEscalationPath = (ctx: ExtensionContext, escalationId: string) => path.join(swarmEscalationDir(ctx), `${sanitize(escalationId)}.json`);

	function nowIso(): string {
		return new Date().toISOString();
	}

	function normalizeStringList(value: unknown): string[] {
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
	}

	function migrateSwarmRun(raw: Partial<SwarmRun> & { id: string; name?: string }): SwarmRun {
		const timestamp = nowIso();
		return {
			id: sanitize(raw.id),
			name: raw.name || raw.id,
			goal: raw.goal || "",
			constraints: normalizeStringList(raw.constraints),
			status: raw.status || "active",
			maxAgents: raw.maxAgents ?? 4,
			agentIds: normalizeStringList(raw.agentIds),
			decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
			blockers: Array.isArray(raw.blockers) ? raw.blockers : [],
			verification: raw.verification,
			createdAt: raw.createdAt || timestamp,
			updatedAt: raw.updatedAt || timestamp,
		};
	}

	function migrateSwarmAgent(raw: Partial<SwarmAgent> & { id: string; runId: string; loopName: string }): SwarmAgent {
		const timestamp = nowIso();
		return {
			id: sanitize(raw.id),
			runId: sanitize(raw.runId),
			role: raw.role || raw.id,
			mode: raw.mode || "read-only",
			loopName: sanitize(raw.loopName),
			taskFile: raw.taskFile || path.join(RALPH_DIR, `${sanitize(raw.loopName)}.md`),
			status: raw.status || "queued",
			allowedPaths: normalizeStringList(raw.allowedPaths),
			ownedPaths: normalizeStringList(raw.ownedPaths),
			dependencies: normalizeStringList(raw.dependencies),
			maxIterations: raw.maxIterations ?? 20,
			itemsPerIteration: raw.itemsPerIteration ?? 2,
			reflectEvery: raw.reflectEvery ?? 5,
			lastSummary: raw.lastSummary,
			lastQueueFile: raw.lastQueueFile,
			createdAt: raw.createdAt || timestamp,
			updatedAt: raw.updatedAt || timestamp,
		};
	}

	function migrateSwarmQueueRecord(raw: Partial<SwarmQueueRecord> & { id: string; runId: string; agentId: string; loopName: string }): SwarmQueueRecord {
		return {
			schemaVersion: raw.schemaVersion ?? 1,
			id: sanitize(raw.id),
			runId: sanitize(raw.runId),
			agentId: sanitize(raw.agentId),
			loopName: sanitize(raw.loopName),
			status: raw.status || "queued",
			delivery: raw.delivery || "pi-ralph-followup",
			queueGeneration: raw.queueGeneration ?? 0,
			queuedAt: raw.queuedAt || nowIso(),
			deliveredAt: raw.deliveredAt,
			deliveredBy: raw.deliveredBy,
			failureReason: raw.failureReason,
			promptFile: raw.promptFile || path.join(SWARM_DIR, "queue", `${sanitize(raw.id)}.prompt.md`),
			stateFile: raw.stateFile || path.join(RALPH_DIR, `${sanitize(raw.loopName)}.state.json`),
			taskFile: raw.taskFile || path.join(RALPH_DIR, `${sanitize(raw.loopName)}.md`),
			note: raw.note,
		};
	}

	function migrateSwarmEscalationRecord(raw: Partial<SwarmEscalationRecord> & { id: string; runId: string; agentId: string; loopName: string; question: string }): SwarmEscalationRecord {
		return {
			schemaVersion: raw.schemaVersion ?? 1,
			id: sanitize(raw.id),
			runId: sanitize(raw.runId),
			agentId: sanitize(raw.agentId),
			loopName: sanitize(raw.loopName),
			status: raw.status || "open",
			severity: raw.severity || "medium",
			question: raw.question || "",
			context: raw.context,
			evidenceFiles: normalizeStringList(raw.evidenceFiles),
			recommendedOptions: normalizeStringList(raw.recommendedOptions),
			needsOrchestratorDecision: raw.needsOrchestratorDecision ?? true,
			createdAt: raw.createdAt || nowIso(),
			resolvedAt: raw.resolvedAt,
			resolvedBy: raw.resolvedBy,
			decision: raw.decision,
			resolutionNote: raw.resolutionNote,
		};
	}

	function loadSwarmRun(ctx: ExtensionContext, runId: string): SwarmRun | null {
		const content = tryRead(swarmRunPath(ctx, runId));
		return content ? migrateSwarmRun(JSON.parse(content)) : null;
	}

	function saveSwarmRun(ctx: ExtensionContext, run: SwarmRun): void {
		run.updatedAt = nowIso();
		const filePath = swarmRunPath(ctx, run.id);
		ensureDir(filePath);
		fs.writeFileSync(filePath, JSON.stringify(run, null, 2), "utf-8");
	}

	function loadSwarmAgent(ctx: ExtensionContext, agentId: string): SwarmAgent | null {
		const content = tryRead(swarmAgentPath(ctx, agentId));
		return content ? migrateSwarmAgent(JSON.parse(content)) : null;
	}

	function saveSwarmAgent(ctx: ExtensionContext, agent: SwarmAgent): void {
		agent.updatedAt = nowIso();
		const filePath = swarmAgentPath(ctx, agent.id);
		ensureDir(filePath);
		fs.writeFileSync(filePath, JSON.stringify(agent, null, 2), "utf-8");
	}

	function listSwarmRuns(ctx: ExtensionContext): SwarmRun[] {
		const dir = swarmDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".run.json"))
			.map((f) => {
				const content = tryRead(path.join(dir, f));
				return content ? migrateSwarmRun(JSON.parse(content)) : null;
			})
			.filter((run): run is SwarmRun => run !== null);
	}

	function listSwarmAgents(ctx: ExtensionContext, runId?: string): SwarmAgent[] {
		const dir = swarmDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".agent.json"))
			.map((f) => {
				const content = tryRead(path.join(dir, f));
				return content ? migrateSwarmAgent(JSON.parse(content)) : null;
			})
			.filter((agent): agent is SwarmAgent => agent !== null && (!runId || agent.runId === sanitize(runId)));
	}

	function loadSwarmQueueRecord(ctx: ExtensionContext, queueId: string): SwarmQueueRecord | null {
		const content = tryRead(swarmQueuePath(ctx, queueId));
		return content ? migrateSwarmQueueRecord(JSON.parse(content)) : null;
	}

	function saveSwarmQueueRecord(ctx: ExtensionContext, record: SwarmQueueRecord): void {
		const filePath = swarmQueuePath(ctx, record.id);
		ensureDir(filePath);
		fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
	}

	function listSwarmQueueRecords(ctx: ExtensionContext, filters: { runId?: string; agentId?: string; status?: SwarmQueueStatus } = {}): SwarmQueueRecord[] {
		const dir = swarmQueueDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				const content = tryRead(path.join(dir, f));
				return content ? migrateSwarmQueueRecord(JSON.parse(content)) : null;
			})
			.filter((record): record is SwarmQueueRecord => {
				if (!record) return false;
				if (filters.runId && record.runId !== sanitize(filters.runId)) return false;
				if (filters.agentId && record.agentId !== sanitize(filters.agentId)) return false;
				if (filters.status && record.status !== filters.status) return false;
				return true;
			})
			.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
	}

	function loadSwarmEscalationRecord(ctx: ExtensionContext, escalationId: string): SwarmEscalationRecord | null {
		const content = tryRead(swarmEscalationPath(ctx, escalationId));
		return content ? migrateSwarmEscalationRecord(JSON.parse(content)) : null;
	}

	function saveSwarmEscalationRecord(ctx: ExtensionContext, record: SwarmEscalationRecord): void {
		const filePath = swarmEscalationPath(ctx, record.id);
		ensureDir(filePath);
		fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
	}

	function listSwarmEscalationRecords(ctx: ExtensionContext, filters: { runId?: string; agentId?: string; status?: SwarmEscalationStatus } = {}): SwarmEscalationRecord[] {
		const dir = swarmEscalationDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				const content = tryRead(path.join(dir, f));
				return content ? migrateSwarmEscalationRecord(JSON.parse(content)) : null;
			})
			.filter((record): record is SwarmEscalationRecord => {
				if (!record) return false;
				if (filters.runId && record.runId !== sanitize(filters.runId)) return false;
				if (filters.agentId && record.agentId !== sanitize(filters.agentId)) return false;
				if (filters.status && record.status !== filters.status) return false;
				return true;
			})
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	function latestActiveSwarmRun(ctx: ExtensionContext): SwarmRun | null {
		const runs = listSwarmRuns(ctx).filter((run) => run.status === "active");
		if (runs.length === 0) return null;
		return runs.reduce((best, candidate) => (candidate.updatedAt > best.updatedAt ? candidate : best));
	}

	function loadTargetSwarmRun(ctx: ExtensionContext, runId?: string): SwarmRun | null {
		if (runId) return loadSwarmRun(ctx, runId);
		if (currentSwarm) {
			const current = loadSwarmRun(ctx, currentSwarm);
			if (current) return current;
		}
		return latestActiveSwarmRun(ctx);
	}

	function syncSwarmAgentFromLoop(ctx: ExtensionContext, agent: SwarmAgent): SwarmAgent {
		const loop = loadState(ctx, agent.loopName);
		if (!loop) return agent;
		if (loop.status === "completed" && agent.status !== "cancelled") agent.status = "completed";
		else if (loop.status === "paused" && agent.status !== "blocked" && agent.status !== "cancelled" && agent.status !== "queued") agent.status = "paused";
		else if (loop.status === "active" && agent.status !== "blocked" && agent.status !== "cancelled" && agent.status !== "queued") agent.status = "active";
		saveSwarmAgent(ctx, agent);
		return agent;
	}

	function markSwarmAgentByLoop(ctx: ExtensionContext, loopName: string, status: SwarmAgentStatus): void {
		for (const agent of listSwarmAgents(ctx)) {
			if (agent.loopName !== loopName) continue;
			agent.status = status;
			saveSwarmAgent(ctx, agent);
			const run = loadSwarmRun(ctx, agent.runId);
			if (run) saveSwarmRun(ctx, run);
		}
	}

	function cognitiveLoad(ctx: ExtensionContext, run: SwarmRun): CognitiveLoadReport {
		const agents = listSwarmAgents(ctx, run.id).map((agent) => syncSwarmAgentFromLoop(ctx, agent));
		const budgetAgents = agents.filter((agent) => agent.status !== "completed" && agent.status !== "cancelled");
		const activeAgents = agents.filter((agent) => agent.status === "active").length;
		const writerAgents = agents.filter((agent) => agent.status === "active" && agent.mode === "writer").length;
		const blockedAgents = agents.filter((agent) => agent.status === "blocked").length;
		const unresolvedBlockers = run.blockers.filter((blocker) => !blocker.resolvedAt).length;
		const openEscalations = listSwarmEscalationRecords(ctx, { runId: run.id, status: "open" });
		const highEscalations = openEscalations.filter((record) => record.severity === "high").length;
		const pathOwners = new Map<string, string[]>();
		for (const agent of agents) {
			for (const ownerPath of agent.ownedPaths) {
				const owners = pathOwners.get(ownerPath) || [];
				owners.push(agent.id);
				pathOwners.set(ownerPath, owners);
			}
		}
		const overlaps = [...pathOwners.values()].filter((owners) => owners.length > 1).length;

		let score = activeAgents + writerAgents * 2 + blockedAgents * 2 + unresolvedBlockers * 2 + openEscalations.length * 2 + highEscalations * 2 + overlaps * 2;
		if (budgetAgents.length > run.maxAgents) score += budgetAgents.length - run.maxAgents;

		const reasons: string[] = [];
		if (activeAgents > 0) reasons.push(`${activeAgents} active agent(s)`);
		if (writerAgents > 1) reasons.push(`${writerAgents} active writer agent(s)`);
		if (blockedAgents > 0) reasons.push(`${blockedAgents} blocked agent(s)`);
		if (unresolvedBlockers > 0) reasons.push(`${unresolvedBlockers} unresolved blocker(s)`);
		if (openEscalations.length > 0) reasons.push(`${openEscalations.length} open escalation(s)`);
		if (highEscalations > 0) reasons.push(`${highEscalations} high escalation(s)`);
		if (overlaps > 0) reasons.push(`${overlaps} overlapping owned path(s)`);
		if (budgetAgents.length > run.maxAgents) reasons.push(`${budgetAgents.length}/${run.maxAgents} non-terminal agent budget exceeded`);
		if (reasons.length === 0) reasons.push("within budget");

		let level: CognitiveLoadLevel = "low";
		if (score >= 10) level = "critical";
		else if (score >= 7) level = "high";
		else if (score >= 4) level = "medium";

		return { level, score, reasons, activeAgents, writerAgents, blockedAgents, budgetAgents: budgetAgents.length, totalAgents: agents.length };
	}

	function ownedPathOverlaps(agents: SwarmAgent[]): Array<[string, string[]]> {
		const pathOwners = new Map<string, string[]>();
		for (const agent of agents) {
			for (const ownerPath of agent.ownedPaths) {
				const owners = pathOwners.get(ownerPath) || [];
				owners.push(agent.id);
				pathOwners.set(ownerPath, owners);
			}
		}
		return [...pathOwners.entries()].filter(([, owners]) => owners.length > 1);
	}

	function adviseSwarm(ctx: ExtensionContext, run: SwarmRun): SwarmAdvice {
		const load = cognitiveLoad(ctx, run);
		const agents = listSwarmAgents(ctx, run.id).map((agent) => syncSwarmAgentFromLoop(ctx, agent));
		const activeAgents = agents.filter((agent) => agent.status === "active");
		const activeWriters = activeAgents.filter((agent) => agent.mode === "writer");
		const activeVerifiers = activeAgents.filter((agent) => agent.mode === "verifier");
		const queued = listSwarmQueueRecords(ctx, { runId: run.id, status: "queued" });
		const openEscalations = listSwarmEscalationRecords(ctx, { runId: run.id, status: "open" });
		const highEscalations = openEscalations.filter((record) => record.severity === "high");
		const unresolvedBlockers = run.blockers.filter((blocker) => !blocker.resolvedAt);
		const overlaps = ownedPathOverlaps(agents);
		const recommendations: string[] = [];

		if (load.level === "critical") recommendations.push("Pause risky spawning and reduce active work before assigning more tasks.");
		if (highEscalations.length > 0) recommendations.push("Resolve high-severity escalations before any new edits.");
		else if (openEscalations.length > 0) recommendations.push("Review open escalations before spawning new agents.");
		if (unresolvedBlockers.length > 0) recommendations.push("Record an orchestrator decision or blocker resolution before continuing implementation.");
		if (activeWriters.length > 1) recommendations.push("Reduce to one active writer or split owned paths before more edits.");
		if (overlaps.length > 0) recommendations.push(`Resolve overlapping ownership: ${overlaps.map(([ownerPath, ids]) => `${ownerPath} (${ids.join(",")})`).join("; ")}.`);
		if (activeWriters.length === 1 && activeVerifiers.length === 0) recommendations.push(`Add or resume a verifier for writer-owned paths: ${activeWriters[0].ownedPaths.join(",") || "unspecified"}.`);
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

	function renderSwarmAdvice(advice: SwarmAdvice): string {
		return [`Advice: ${advice.summary}`, ...advice.recommendations.map((item) => `- ${item}`)].join("\n");
	}

	function renderSwarmBoard(ctx: ExtensionContext, run: SwarmRun): string {
		const agents = listSwarmAgents(ctx, run.id).map((agent) => syncSwarmAgentFromLoop(ctx, agent));
		const load = cognitiveLoad(ctx, run);
		const queuedCount = listSwarmQueueRecords(ctx, { runId: run.id, status: "queued" }).length;
		const lines = [
			`Swarm: ${run.id} (${SWARM_STATUS_ICONS[run.status]} ${run.status})`,
			`Goal: ${run.goal || "(none recorded)"}`,
			`Load: ${load.level} (${load.score}) - ${load.reasons.join(", ")}`,
			`Budget: ${load.budgetAgents}/${run.maxAgents} non-terminal agent(s), ${load.totalAgents} total`,
		];
		if (queuedCount > 0) lines.push(`Queue: ${queuedCount} queued prompt(s)`);
		lines.push(`Advice: ${adviseSwarm(ctx, run).summary}`);
		if (run.constraints.length > 0) lines.push(`Constraints: ${run.constraints.join("; ")}`);
		if (agents.length === 0) {
			lines.push("Agents: none");
		} else {
			lines.push("Agents:");
			for (const agent of agents) {
				const paths = agent.ownedPaths.length > 0 ? ` owns ${agent.ownedPaths.join(",")}` : "";
				lines.push(`- ${agent.id}: ${SWARM_STATUS_ICONS[agent.status]} ${agent.status}, ${agent.mode}, loop ${agent.loopName}${paths}`);
			}
		}
		const unresolved = run.blockers.filter((blocker) => !blocker.resolvedAt);
		if (unresolved.length > 0) lines.push(`Blockers: ${unresolved.map((blocker) => blocker.text).join("; ")}`);
		if (run.decisions.length > 0) lines.push(`Latest decision: ${run.decisions[run.decisions.length - 1].text}`);
		return lines.join("\n");
	}

	function renderSwarmQueue(records: SwarmQueueRecord[]): string {
		if (records.length === 0) return "No swarm queue records.";
		return records
			.map((record) => {
				const delivered = record.deliveredAt ? ` delivered=${record.deliveredAt}` : "";
				const failure = record.failureReason ? ` failure=${record.failureReason}` : "";
				return `${record.id}: ${record.status}, agent=${record.agentId}, gen=${record.queueGeneration}, queued=${record.queuedAt}${delivered}${failure}`;
			})
			.join("\n");
	}

	function renderSwarmEscalations(records: SwarmEscalationRecord[]): string {
		if (records.length === 0) return "No swarm escalations.";
		return records
			.map((record) => {
				const resolved = record.resolvedAt ? ` resolved=${record.resolvedAt}` : "";
				return `${record.id}: ${record.status}, ${record.severity}, agent=${record.agentId}, decision=${record.needsOrchestratorDecision}, created=${record.createdAt}${resolved}\n  Q: ${record.question}`;
			})
			.join("\n");
	}

	function createSwarmEscalation(
		ctx: ExtensionContext,
		agent: SwarmAgent,
		params: {
			severity?: SwarmEscalationSeverity;
			question: string;
			context?: string;
			evidenceFiles?: string[];
			recommendedOptions?: string[];
			needsOrchestratorDecision?: boolean;
			pauseAgent?: boolean;
		},
	): SwarmEscalationRecord {
		const createdAt = nowIso();
		const severity = params.severity || "medium";
		const id = `${createdAt.replace(/[:.]/g, "-")}-${agent.id}`;
		const record: SwarmEscalationRecord = {
			schemaVersion: 1,
			id,
			runId: agent.runId,
			agentId: agent.id,
			loopName: agent.loopName,
			status: "open",
			severity,
			question: params.question,
			context: params.context,
			evidenceFiles: params.evidenceFiles || [],
			recommendedOptions: params.recommendedOptions || [],
			needsOrchestratorDecision: params.needsOrchestratorDecision ?? true,
			createdAt,
		};
		saveSwarmEscalationRecord(ctx, record);

		const shouldPause = params.pauseAgent ?? severity === "high";
		if (shouldPause) {
			const loop = loadState(ctx, agent.loopName);
			if (loop) {
				loop.status = "paused";
				loop.active = false;
				saveState(ctx, loop);
			}
			agent.status = severity === "high" ? "blocked" : "paused";
			saveSwarmAgent(ctx, agent);
		}
		const run = loadSwarmRun(ctx, agent.runId);
		if (run) {
			if (severity === "high") {
				run.blockers.push({ text: `Escalation ${record.id}: ${record.question}`, neededDecision: params.needsOrchestratorDecision ? "orchestrator decision" : undefined, createdAt });
			}
			saveSwarmRun(ctx, run);
		}
		updateUI(ctx);
		return record;
	}

	function resolveSwarmEscalation(ctx: ExtensionContext, record: SwarmEscalationRecord, decision: string, resolutionNote?: string): SwarmEscalationRecord {
		record.status = "resolved";
		record.resolvedAt = record.resolvedAt || nowIso();
		record.resolvedBy = "orchestrator";
		record.decision = decision || record.decision;
		record.resolutionNote = resolutionNote || record.resolutionNote;
		saveSwarmEscalationRecord(ctx, record);
		const agent = loadSwarmAgent(ctx, record.agentId);
		if (agent?.status === "blocked") {
			agent.status = "paused";
			saveSwarmAgent(ctx, agent);
		}
		const run = loadSwarmRun(ctx, record.runId);
		if (run) {
			for (const blocker of run.blockers) {
				if (!blocker.resolvedAt && blocker.text.startsWith(`Escalation ${record.id}:`)) blocker.resolvedAt = record.resolvedAt;
			}
			if (decision) run.decisions.push({ text: `Resolved escalation ${record.id}: ${decision}`, rationale: resolutionNote, createdAt: record.resolvedAt });
			saveSwarmRun(ctx, run);
		}
		updateUI(ctx);
		return record;
	}

	function markQueueRecord(ctx: ExtensionContext, record: SwarmQueueRecord, status: SwarmQueueStatus, failureReason?: string): SwarmQueueRecord {
		record.status = status;
		if (status === "delivered") {
			record.deliveredAt = nowIso();
			record.deliveredBy = "pi-ralph-wiggum";
		}
		if (failureReason) record.failureReason = failureReason;
		saveSwarmQueueRecord(ctx, record);
		return record;
	}

	function deliverQueuedSwarmPrompt(ctx: ExtensionContext, record: SwarmQueueRecord): string {
		if (record.status !== "queued") return `${record.id}: skipped (${record.status})`;
		if (ctx.hasPendingMessages()) return `${record.id}: pending Pi messages already queued; drain later`;

		const agent = loadSwarmAgent(ctx, record.agentId);
		if (!agent) {
			markQueueRecord(ctx, record, "failed", `Agent not found: ${record.agentId}`);
			return `${record.id}: failed (agent not found)`;
		}
		if (agent.status === "cancelled") {
			markQueueRecord(ctx, record, "stale", `Agent is cancelled: ${agent.id}`);
			return `${record.id}: stale (agent cancelled)`;
		}

		const state = loadState(ctx, record.loopName);
		if (!state) {
			markQueueRecord(ctx, record, "failed", `Loop state not found: ${record.loopName}`);
			return `${record.id}: failed (loop state not found)`;
		}
		if (state.status === "completed") {
			markQueueRecord(ctx, record, "stale", `Loop is completed: ${record.loopName}`);
			return `${record.id}: stale (loop completed)`;
		}
		if ((state.queueGeneration ?? 0) !== record.queueGeneration) {
			markQueueRecord(ctx, record, "stale", `Queue generation mismatch: state=${state.queueGeneration ?? 0}, record=${record.queueGeneration}`);
			return `${record.id}: stale (queue generation mismatch)`;
		}

		const promptPath = path.resolve(ctx.cwd, record.promptFile);
		const prompt = tryRead(promptPath);
		if (!prompt) {
			markQueueRecord(ctx, record, "failed", `Prompt file not found: ${record.promptFile}`);
			return `${record.id}: failed (prompt file not found)`;
		}

		state.status = "active";
		state.active = true;
		saveState(ctx, state);
		agent.status = "active";
		agent.lastQueueFile = path.relative(ctx.cwd, swarmQueuePath(ctx, record.id));
		saveSwarmAgent(ctx, agent);
		const run = loadSwarmRun(ctx, record.runId);
		if (run) {
			currentSwarm = run.id;
			saveSwarmRun(ctx, run);
		}
		currentLoop = state.name;
		pi.sendUserMessage(prompt, {
			deliverAs: "followUp",
			streamingBehavior: "followUp",
		});
		markQueueRecord(ctx, record, "delivered");
		updateUI(ctx);
		return `${record.id}: delivered to Pi/Ralph follow-up`;
	}

	function buildSwarmAgentTaskContent(
		run: SwarmRun,
		role: string,
		taskContent: string,
		mode: SwarmAgentMode,
		allowedPaths: string[],
		ownedPaths: string[],
	): string {
		const scope = [
			`Mode: ${mode}`,
			`Allowed paths: ${allowedPaths.length > 0 ? allowedPaths.join(", ") : "not specified"}`,
			`Owned paths: ${ownedPaths.length > 0 ? ownedPaths.join(", ") : "none"}`,
		].join("\n");

		return `# Swarm Agent: ${role}

## Run
- Swarm: ${run.id}
- Goal: ${run.goal}

## Role
${role}

## Scope
${scope}

## Constraints
${run.constraints.length > 0 ? run.constraints.map((constraint) => `- ${constraint}`).join("\n") : "- Follow the top-level user instructions and repository safety rules."}

## Task
${taskContent}

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

## Return Format
- Status
- Findings
- Commands run
- Evidence
- Risks
- Next recommended action

## Notes
(Update this as you work)
`;
	}

	// --- Loop state transitions ---

	function pauseLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "paused";
		state.active = false;
		saveState(ctx, state);
		markSwarmAgentByLoop(ctx, state.name, "paused");
		currentLoop = null;
		updateUI(ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function completeLoop(ctx: ExtensionContext, state: LoopState, banner: string): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		state.active = false;
		saveState(ctx, state);
		markSwarmAgentByLoop(ctx, state.name, "completed");
		currentLoop = null;
		updateUI(ctx);
		pi.sendUserMessage(banner, {
			deliverAs: "followUp",
			streamingBehavior: "followUp",
		});
	}

	function stopLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		state.active = false;
		saveState(ctx, state);
		markSwarmAgentByLoop(ctx, state.name, "completed");
		currentLoop = null;
		updateUI(ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	// --- UI ---

	function formatLoop(l: LoopState): string {
		const status = `${STATUS_ICONS[l.status]} ${l.status}`;
		const iter = l.maxIterations > 0 ? `${l.iteration}/${l.maxIterations}` : `${l.iteration}`;
		return `${l.name}: ${status} (iteration ${iter})`;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		updateSwarmUI(ctx);

		const state = currentLoop ? loadState(ctx, currentLoop) : null;
		if (!state) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

		const { theme } = ctx.ui;
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";

		ctx.ui.setStatus("ralph", theme.fg("accent", `🔄 ${state.name} (${state.iteration}${maxStr})`));

		const lines = [
			theme.fg("accent", theme.bold("Ralph Wiggum")),
			theme.fg("muted", `Loop: ${state.name}`),
			theme.fg("dim", `Status: ${STATUS_ICONS[state.status]} ${state.status}`),
			theme.fg("dim", `Iteration: ${state.iteration}${maxStr}`),
			theme.fg("dim", `Task: ${state.taskFile}`),
		];
		if (state.reflectEvery > 0) {
			const next = state.reflectEvery - ((state.iteration - 1) % state.reflectEvery);
			lines.push(theme.fg("dim", `Next reflection in: ${next} iterations`));
		}
		// Warning about stopping
		lines.push("");
		lines.push(theme.fg("warning", "ESC pauses the assistant"));
		lines.push(theme.fg("warning", "Send a message to resume; /ralph-stop ends the loop"));
		ctx.ui.setWidget("ralph", lines);
	}

	function updateSwarmUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const run = loadTargetSwarmRun(ctx);
		if (!run) {
			ctx.ui.setStatus("swarm", undefined);
			ctx.ui.setWidget("swarm", undefined);
			return;
		}
		const load = cognitiveLoad(ctx, run);
		const { theme } = ctx.ui;
		ctx.ui.setStatus("swarm", theme.fg("accent", `swarm ${run.id}: ${load.level}`));
		ctx.ui.setWidget(
			"swarm",
			renderSwarmBoard(ctx, run)
				.split("\n")
				.map((line, idx) => (idx === 0 ? theme.fg("accent", theme.bold(line)) : theme.fg("dim", line))),
		);
	}

	// --- Prompt building ---

	function buildPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;

		const parts = [header, ""];
		if (isReflection) parts.push(state.reflectInstructions, "\n---\n");

		parts.push(`## Current Task (from ${state.taskFile})\n\n${taskContent}\n\n---`);
		parts.push(`\n## Stale Prompt Guard\n\n${DEFAULT_STALE_PROMPT_GUARD}\n`);
		parts.push(`\n## Completion Gate\n\n${DEFAULT_COMPLETION_GATE}\n`);
		parts.push(`\n## Instructions\n`);
		parts.push("User controls: ESC pauses the assistant. Send a message to resume. Run /ralph-stop when idle to stop the loop.\n");
		parts.push(
			`You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`,
		);

		if (state.itemsPerIteration > 0) {
			parts.push(`**THIS ITERATION: Process approximately ${state.itemsPerIteration} items, then call ralph_done.**\n`);
			parts.push(`1. Work on the next ~${state.itemsPerIteration} items from your checklist`);
		} else {
			parts.push(`1. Continue working on the task`);
		}
		parts.push(`2. Update the task file (${state.taskFile}) with your progress`);
		parts.push(`3. When FULLY COMPLETE and the completion gate is satisfied, respond with: ${COMPLETE_MARKER}`);
		parts.push(`4. Otherwise, call ralph_done with {"name":"${state.name}"} to proceed to next iteration`);

		return parts.join("\n");
	}

	// --- Arg parsing ---

	function parseArgs(argsStr: string) {
		const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
		const result = {
			name: "",
			maxIterations: 50,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
		};

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			const next = tokens[i + 1];
			if (tok === "--max-iterations" && next) {
				result.maxIterations = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--items-per-iteration" && next) {
				result.itemsPerIteration = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--reflect-every" && next) {
				result.reflectEvery = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--reflect-instructions" && next) {
				result.reflectInstructions = next.replace(/^"|"$/g, "");
				i++;
			} else if (!tok.startsWith("--")) {
				result.name = tok;
			}
		}
		return result;
	}

	function advanceRalphLoop(ctx: ExtensionContext, loopName: string): string {
		const state = loadState(ctx, loopName);
		if (!state || state.status !== "active") return "Ralph loop is not active.";

		if (ctx.hasPendingMessages()) return "Pending messages already queued. Skipping ralph_done.";

		state.iteration++;

		if (state.maxIterations > 0 && state.iteration > state.maxIterations) {
			completeLoop(
				ctx,
				state,
				`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
──────────────────────────────────────────────────────────────────────`,
			);
			return "Max iterations reached. Loop stopped.";
		}

		const needsReflection = state.reflectEvery > 0 && (state.iteration - 1) % state.reflectEvery === 0;
		if (needsReflection) state.lastReflectionAt = state.iteration;

		saveState(ctx, state);
		currentLoop = state.name;
		updateUI(ctx);

		const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
		if (!content) {
			pauseLoop(ctx, state);
			return `Error: Could not read task file: ${state.taskFile}`;
		}

		pi.sendUserMessage(buildPrompt(state, content, needsReflection), {
			deliverAs: "followUp",
			streamingBehavior: "followUp",
		});

		return `Iteration ${state.iteration - 1} complete. Next iteration queued.`;
	}

	function continueCompletedLoopState(state: LoopState, activate: boolean): boolean {
		const wasCompleted = state.status === "completed";
		if (wasCompleted) {
			state.iteration = Math.max(1, state.iteration + 1);
			if (state.maxIterations > 0 && state.iteration > state.maxIterations) state.maxIterations = state.iteration;
			delete state.completedAt;
			state.continuedAt = nowIso();
		}
		state.status = activate ? "active" : "paused";
		state.active = activate;
		return wasCompleted;
	}

	function continueSwarmAgent(ctx: ExtensionContext, agent: SwarmAgent, activate: boolean): string {
		const state = loadState(ctx, agent.loopName);
		if (!state) return `Ralph loop not found for swarm agent: ${agent.loopName}`;
		const changed = continueCompletedLoopState(state, activate);
		saveState(ctx, state);
		agent.status = state.status as SwarmAgentStatus;
		agent.updatedAt = nowIso();
		saveSwarmAgent(ctx, agent);
		if (!activate) return changed ? `Continued ${agent.id} paused at iteration ${state.iteration}/${state.maxIterations}` : `${agent.id}: loop was not completed; left paused.`;

		const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
		if (!content) {
			pauseLoop(ctx, state);
			return `Error: Could not read task file: ${state.taskFile}`;
		}
		currentLoop = state.name;
		pi.sendUserMessage(buildPrompt(state, content, false), {
			deliverAs: "followUp",
			streamingBehavior: "followUp",
		});
		return changed ? `Continued ${agent.id} at iteration ${state.iteration}/${state.maxIterations}. Prompt queued.` : `${agent.id}: loop was already ${state.status}. Prompt queued.`;
	}

	// --- Commands ---

	const commands: Record<string, (rest: string, ctx: ExtensionContext) => void> = {
		start(rest, ctx) {
			const args = parseArgs(rest);
			if (!args.name) {
				ctx.ui.notify(
					"Usage: /ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
					"warning",
				);
				return;
			}

			const isPath = args.name.includes("/") || args.name.includes("\\");
			const loopName = isPath ? sanitize(path.basename(args.name, path.extname(args.name))) : args.name;
			const taskFile = isPath ? args.name : path.join(RALPH_DIR, `${loopName}.md`);

			const existing = loadState(ctx, loopName);
			if (existing?.status === "active") {
				ctx.ui.notify(`Loop "${loopName}" is already active. Use /ralph resume ${loopName}`, "warning");
				return;
			}

			const fullPath = path.resolve(ctx.cwd, taskFile);
			if (!fs.existsSync(fullPath)) {
				ensureDir(fullPath);
				fs.writeFileSync(fullPath, DEFAULT_TEMPLATE, "utf-8");
				ctx.ui.notify(`Created task file: ${taskFile}`, "info");
			}

			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: args.maxIterations,
				itemsPerIteration: args.itemsPerIteration,
				reflectEvery: args.reflectEvery,
				reflectInstructions: args.reflectInstructions,
				active: true,
				status: "active",
				startedAt: existing?.startedAt || new Date().toISOString(),
				lastReflectionAt: 0,
			};

			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			const content = tryRead(fullPath);
			if (!content) {
				ctx.ui.notify(`Could not read task file: ${taskFile}`, "error");
				return;
			}
			pi.sendUserMessage(buildPrompt(state, content, false), {
				deliverAs: "followUp",
				streamingBehavior: "followUp",
			});
		},

		stop(_rest, ctx) {
			if (!currentLoop) {
				// Check persisted state for any active loop
				const active = listLoops(ctx).find((l) => l.status === "active");
				if (active) {
					pauseLoop(ctx, active, `Paused Ralph loop: ${active.name} (iteration ${active.iteration})`);
				} else {
					ctx.ui.notify("No active Ralph loop", "warning");
				}
				return;
			}
			const state = loadState(ctx, currentLoop);
			if (state) {
				pauseLoop(ctx, state, `Paused Ralph loop: ${currentLoop} (iteration ${state.iteration})`);
			}
		},

		resume(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph resume <name>", "warning");
				return;
			}

			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			const continued = state.status === "completed";

			// Pause current loop if different
			if (currentLoop && currentLoop !== loopName) {
				const curr = loadState(ctx, currentLoop);
				if (curr) pauseLoop(ctx, curr);
			}

			if (continued) {
				continueCompletedLoopState(state, true);
			} else {
				state.status = "active";
				state.active = true;
				state.iteration++;
			}
			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			ctx.ui.notify(`${continued ? "Continued" : "Resumed"}: ${loopName} (iteration ${state.iteration})`, "info");

			const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
			if (!content) {
				ctx.ui.notify(`Could not read task file: ${state.taskFile}`, "error");
				return;
			}

			const needsReflection =
				state.reflectEvery > 0 && state.iteration > 1 && (state.iteration - 1) % state.reflectEvery === 0;
			pi.sendUserMessage(buildPrompt(state, content, needsReflection), {
				deliverAs: "followUp",
				streamingBehavior: "followUp",
			});
		},

		status(_rest, ctx) {
			const loops = listLoops(ctx);
			if (loops.length === 0) {
				ctx.ui.notify("No Ralph loops found.", "info");
				return;
			}
			ctx.ui.notify(`Ralph loops:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
		},

		cancel(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph cancel <name>", "warning");
				return;
			}
			if (!loadState(ctx, loopName)) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (currentLoop === loopName) currentLoop = null;
			tryDelete(getPath(ctx, loopName, ".state.json"));
			ctx.ui.notify(`Cancelled: ${loopName}`, "info");
			updateUI(ctx);
		},

		archive(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph archive <name>", "warning");
				return;
			}
			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (state.status === "active") {
				ctx.ui.notify("Cannot archive active loop. Stop it first.", "warning");
				return;
			}

			if (currentLoop === loopName) currentLoop = null;

			const srcState = getPath(ctx, loopName, ".state.json");
			const dstState = getPath(ctx, loopName, ".state.json", true);
			ensureDir(dstState);
			if (fs.existsSync(srcState)) fs.renameSync(srcState, dstState);

			const srcTask = path.resolve(ctx.cwd, state.taskFile);
			if (srcTask.startsWith(ralphDir(ctx)) && !srcTask.startsWith(archiveDir(ctx))) {
				const dstTask = getPath(ctx, loopName, ".md", true);
				if (fs.existsSync(srcTask)) fs.renameSync(srcTask, dstTask);
			}

			ctx.ui.notify(`Archived: ${loopName}`, "info");
			updateUI(ctx);
		},

		clean(rest, ctx) {
			const all = rest.trim() === "--all";
			const completed = listLoops(ctx).filter((l) => l.status === "completed");

			if (completed.length === 0) {
				ctx.ui.notify("No completed loops to clean", "info");
				return;
			}

			for (const loop of completed) {
				tryDelete(getPath(ctx, loop.name, ".state.json"));
				if (all) tryDelete(getPath(ctx, loop.name, ".md"));
				if (currentLoop === loop.name) currentLoop = null;
			}

			const suffix = all ? " (all files)" : " (state only)";
			ctx.ui.notify(
				`Cleaned ${completed.length} loop(s)${suffix}:\n${completed.map((l) => `  • ${l.name}`).join("\n")}`,
				"info",
			);
			updateUI(ctx);
		},

		list(rest, ctx) {
			const archived = rest.trim() === "--archived";
			const loops = listLoops(ctx, archived);

			if (loops.length === 0) {
				ctx.ui.notify(
					archived ? "No archived loops" : "No loops found. Use /ralph list --archived for archived.",
					"info",
				);
				return;
			}

			const label = archived ? "Archived loops" : "Ralph loops";
			ctx.ui.notify(`${label}:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
		},

		nuke(rest, ctx) {
			const force = rest.trim() === "--yes";
			const warning =
				"This deletes all .ralph state, task, and archive files. External task files are not removed.";

			const run = () => {
				const dir = ralphDir(ctx);
				if (!fs.existsSync(dir)) {
					if (ctx.hasUI) ctx.ui.notify("No .ralph directory found.", "info");
					return;
				}

				currentLoop = null;
				currentSwarm = null;
				const ok = tryRemoveDir(dir);
				if (ctx.hasUI) {
					ctx.ui.notify(ok ? "Removed .ralph directory." : "Failed to remove .ralph directory.", ok ? "info" : "error");
				}
				updateUI(ctx);
			};

			if (!force) {
				if (ctx.hasUI) {
					void ctx.ui.confirm("Delete all Ralph loop files?", warning).then((confirmed) => {
						if (confirmed) run();
					});
				} else {
					ctx.ui.notify(`Run /ralph nuke --yes to confirm. ${warning}`, "warning");
				}
				return;
			}

			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			run();
		},
	};

	const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph start <name|path> [options]  Start a new loop
  /ralph stop                         Pause current loop
  /ralph resume <name>                Resume a paused loop
  /ralph status                       Show all loops
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph nuke [--yes]                 Delete all .ralph data
  /ralph-stop                         Stop active loop (idle only)

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50)

To stop: press ESC to interrupt, then run /ralph-stop when idle

Examples:
  /ralph start my-feature
  /ralph start review --items-per-iteration 5 --reflect-every 10`;

	const SWARM_HELP = `Pi Swarm - Ralph-backed subagent orchestration

Commands:
  /swarm start <name> <goal>       Create a swarm run
  /swarm status [run]              Show run board and cognitive load
  /swarm agents [run]              Show agents for a run
  /swarm pause [run]               Pause run metadata
  /swarm resume [run]              Resume run metadata
  /swarm stop [run]                Mark run completed
  /swarm queue [run]               List queued/delivered prompt records
  /swarm drain [run]               Deliver one queued prompt into Pi/Ralph
  /swarm advise [run]              Show manager-side advisor recommendations
  /swarm escalations [run]         List open/resolved escalations
  /swarm summarize [run]           Show compact board

Agents should use the swarm_* tools for structured orchestration.`;

	const swarmCommands: Record<string, (rest: string, ctx: ExtensionContext) => void> = {
		start(rest, ctx) {
			const [name, ...goalParts] = rest.trim().split(/\s+/);
			if (!name) {
				ctx.ui.notify("Usage: /swarm start <name> <goal>", "warning");
				return;
			}
			const runId = sanitize(name);
			const goal = goalParts.join(" ").trim() || "Describe the swarm goal.";
			const run: SwarmRun = {
				id: runId,
				name,
				goal,
				constraints: [],
				status: "active",
				maxAgents: 4,
				agentIds: [],
				decisions: [],
				blockers: [],
				createdAt: nowIso(),
				updatedAt: nowIso(),
			};
			saveSwarmRun(ctx, run);
			currentSwarm = run.id;
			updateUI(ctx);
			ctx.ui.notify(renderSwarmBoard(ctx, run), "info");
		},

		status(rest, ctx) {
			const run = loadTargetSwarmRun(ctx, rest.trim() || undefined);
			ctx.ui.notify(run ? renderSwarmBoard(ctx, run) : "No swarm run found.", run ? "info" : "warning");
		},

		agents(rest, ctx) {
			const run = loadTargetSwarmRun(ctx, rest.trim() || undefined);
			if (!run) {
				ctx.ui.notify("No swarm run found.", "warning");
				return;
			}
			const agents = listSwarmAgents(ctx, run.id).map((agent) => syncSwarmAgentFromLoop(ctx, agent));
			ctx.ui.notify(
				agents.length > 0
					? agents.map((agent) => `${agent.id}: ${agent.status}, ${agent.mode}, loop=${agent.loopName}`).join("\n")
					: `No agents for swarm ${run.id}.`,
				"info",
			);
		},

		advise(rest, ctx) {
			const run = loadTargetSwarmRun(ctx, rest.trim() || undefined);
			ctx.ui.notify(run ? renderSwarmAdvice(adviseSwarm(ctx, run)) : "No swarm run found.", run ? "info" : "warning");
		},

		pause(rest, ctx) {
			const run = loadTargetSwarmRun(ctx, rest.trim() || undefined);
			if (!run) return ctx.ui.notify("No swarm run found.", "warning");
			run.status = "paused";
			saveSwarmRun(ctx, run);
			updateUI(ctx);
			ctx.ui.notify(`Paused swarm: ${run.id}`, "info");
		},

		resume(rest, ctx) {
			const run = loadTargetSwarmRun(ctx, rest.trim() || undefined);
			if (!run) return ctx.ui.notify("No swarm run found.", "warning");
			run.status = "active";
			saveSwarmRun(ctx, run);
			currentSwarm = run.id;
			updateUI(ctx);
			ctx.ui.notify(renderSwarmBoard(ctx, run), "info");
		},

		stop(rest, ctx) {
			const run = loadTargetSwarmRun(ctx, rest.trim() || undefined);
			if (!run) return ctx.ui.notify("No swarm run found.", "warning");
			run.status = "completed";
			saveSwarmRun(ctx, run);
			if (currentSwarm === run.id) currentSwarm = null;
			updateUI(ctx);
			ctx.ui.notify(`Completed swarm: ${run.id}`, "info");
		},

		queue(rest, ctx) {
			const runId = rest.trim() || undefined;
			const run = loadTargetSwarmRun(ctx, runId);
			if (runId && !run) return ctx.ui.notify("No swarm run found.", "warning");
			const records = listSwarmQueueRecords(ctx, run ? { runId: run.id } : {});
			ctx.ui.notify(renderSwarmQueue(records), records.length > 0 ? "info" : "warning");
		},

		drain(rest, ctx) {
			const runId = rest.trim() || undefined;
			const run = loadTargetSwarmRun(ctx, runId);
			if (runId && !run) return ctx.ui.notify("No swarm run found.", "warning");
			const records = listSwarmQueueRecords(ctx, { runId: run?.id, status: "queued" });
			if (records.length === 0) {
				ctx.ui.notify("No queued swarm prompts.", "warning");
				return;
			}
			ctx.ui.notify(deliverQueuedSwarmPrompt(ctx, records[0]), "info");
		},

		escalations(rest, ctx) {
			const runId = rest.trim() || undefined;
			const run = loadTargetSwarmRun(ctx, runId);
			if (runId && !run) return ctx.ui.notify("No swarm run found.", "warning");
			const records = listSwarmEscalationRecords(ctx, run ? { runId: run.id } : {});
			ctx.ui.notify(renderSwarmEscalations(records), records.length > 0 ? "info" : "warning");
		},

		summarize(rest, ctx) {
			const run = loadTargetSwarmRun(ctx, rest.trim() || undefined);
			ctx.ui.notify(run ? renderSwarmBoard(ctx, run) : "No swarm run found.", run ? "info" : "warning");
		},
	};

	pi.registerCommand("ralph", {
		description: "Ralph Wiggum - long-running development loops",
		handler: async (args, ctx) => {
			const [cmd] = args.trim().split(/\s+/);
			const handler = commands[cmd];
			if (handler) {
				handler(args.slice(cmd.length).trim(), ctx);
			} else {
				ctx.ui.notify(HELP, "info");
			}
		},
	});

	pi.registerCommand("swarm", {
		description: "Pi Swarm - Ralph-backed subagent orchestration",
		handler: async (args, ctx) => {
			const [cmd] = args.trim().split(/\s+/);
			const handler = swarmCommands[cmd];
			if (handler) {
				handler(args.slice(cmd.length).trim(), ctx);
			} else {
				ctx.ui.notify(SWARM_HELP, "info");
			}
		},
	});

	pi.registerCommand("ralph-stop", {
		description: "Stop active Ralph loop (idle only)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) {
					ctx.ui.notify("Agent is busy. Press ESC to interrupt, then run /ralph-stop.", "warning");
				}
				return;
			}

			let state = currentLoop ? loadState(ctx, currentLoop) : null;
			if (!state) {
				const active = listLoops(ctx).find((l) => l.status === "active");
				if (!active) {
					if (ctx.hasUI) ctx.ui.notify("No active Ralph loop", "warning");
					return;
				}
				state = active;
			}

			if (state.status !== "active") {
				if (ctx.hasUI) ctx.ui.notify(`Loop "${state.name}" is not active`, "warning");
				return;
			}

			stopLoop(ctx, state, `Stopped Ralph loop: ${state.name} (iteration ${state.iteration})`);
		},
	});

	// --- Tool for agent self-invocation ---

	pi.registerTool({
		name: "ralph_start",
		label: "Start Ralph Loop",
		description: "Start a long-running development loop. Use for complex multi-iteration tasks.",
		promptSnippet: "Start a persistent multi-iteration development loop with pacing and reflection controls.",
		promptGuidelines: [
			"Use this tool when the user explicitly wants an iterative loop, autonomous repeated passes, or paced multi-step execution.",
			"After starting a loop, continue each finished iteration with ralph_done unless the completion marker has already been emitted.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Loop name (e.g., 'refactor-auth')" }),
			taskContent: Type.String({ description: "Task in markdown with goals and checklist" }),
			itemsPerIteration: Type.Optional(Type.Number({ description: "Suggest N items per turn (0 = no limit)" })),
			reflectEvery: Type.Optional(Type.Number({ description: "Reflect every N iterations" })),
			maxIterations: Type.Optional(Type.Number({ description: "Max iterations (default: 50)", default: 50 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loopName = sanitize(params.name);
			const taskFile = path.join(RALPH_DIR, `${loopName}.md`);

			if (loadState(ctx, loopName)?.status === "active") {
				return { content: [{ type: "text", text: `Loop "${loopName}" already active.` }], details: {} };
			}

			const fullPath = path.resolve(ctx.cwd, taskFile);
			ensureDir(fullPath);
			fs.writeFileSync(fullPath, params.taskContent, "utf-8");

			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: params.maxIterations ?? 50,
				itemsPerIteration: params.itemsPerIteration ?? 0,
				reflectEvery: params.reflectEvery ?? 0,
				reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
				active: true,
				status: "active",
				startedAt: new Date().toISOString(),
				lastReflectionAt: 0,
			};

			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			pi.sendUserMessage(buildPrompt(state, params.taskContent, false), {
				deliverAs: "followUp",
				streamingBehavior: "followUp",
			});

			return {
				content: [{ type: "text", text: `Started loop "${loopName}" (max ${state.maxIterations} iterations).` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "swarm_start",
		label: "Start Swarm Run",
		description: "Start a Ralph-backed swarm run for multi-agent orchestration.",
		promptSnippet: "Create a swarm run with a goal, constraints, and cognitive-load budget.",
		promptGuidelines: [
			"Use before spawning multiple Ralph-backed subagents.",
			"Keep constraints explicit so subagents inherit the same safety and verification contract.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Run name" }),
			goal: Type.String({ description: "Top-level swarm objective" }),
			constraints: Type.Optional(Type.Array(Type.String(), { description: "Shared constraints for all agents" })),
			maxAgents: Type.Optional(Type.Number({ description: "Cognitive-load agent budget", default: 4 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runId = sanitize(params.name);
			const run: SwarmRun = {
				id: runId,
				name: params.name,
				goal: params.goal,
				constraints: params.constraints ?? [],
				status: "active",
				maxAgents: params.maxAgents ?? 4,
				agentIds: [],
				decisions: [],
				blockers: [],
				createdAt: nowIso(),
				updatedAt: nowIso(),
			};
			saveSwarmRun(ctx, run);
			currentSwarm = run.id;
			updateUI(ctx);
			return { content: [{ type: "text", text: renderSwarmBoard(ctx, run) }], details: { runId: run.id } };
		},
	});

	pi.registerTool({
		name: "swarm_spawn_agent",
		label: "Spawn Swarm Agent",
		description: "Create a Ralph loop as a scoped swarm subagent.",
		promptSnippet: "Spawn a role-specific Ralph-backed agent with scope, ownership, and pacing controls.",
		promptGuidelines: [
			"Prefer read-only scout/verifier agents when cognitive load is high.",
			"Use ownedPaths for writer agents so overlapping edits are visible.",
		],
		parameters: Type.Object({
			runId: Type.String({ description: "Swarm run id" }),
			role: Type.String({ description: "Agent role name" }),
			taskContent: Type.String({ description: "Role-specific task body" }),
			mode: Type.Optional(Type.Union([
				Type.Literal("read-only"),
				Type.Literal("writer"),
				Type.Literal("verifier"),
				Type.Literal("integrator"),
			])),
			allowedPaths: Type.Optional(Type.Array(Type.String())),
			ownedPaths: Type.Optional(Type.Array(Type.String())),
			dependencies: Type.Optional(Type.Array(Type.String())),
			maxIterations: Type.Optional(Type.Number({ default: 20 })),
			itemsPerIteration: Type.Optional(Type.Number({ default: 2 })),
			reflectEvery: Type.Optional(Type.Number({ default: 5 })),
			autoQueue: Type.Optional(Type.Boolean({ description: "Queue first Ralph prompt immediately", default: true })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const run = loadSwarmRun(ctx, params.runId);
			if (!run) return { content: [{ type: "text", text: `Swarm run not found: ${params.runId}` }], details: {} };
			if (run.status !== "active") return { content: [{ type: "text", text: `Swarm run is ${run.status}: ${run.id}` }], details: {} };
			if (isAdvisorAgentRole(params.role)) {
				return { content: [{ type: "text", text: "Advisor is manager-side behavior, not a swarm agent role. Use swarm_advise instead." }], details: {} };
			}

			const mode = (params.mode ?? "read-only") as SwarmAgentMode;
			const allowedPaths = params.allowedPaths ?? [];
			const ownedPaths = params.ownedPaths ?? [];
			const existingAgents = listSwarmAgents(ctx, run.id);
			const index = existingAgents.length + 1;
			const loopName = sanitize(`swarm-${run.id}-${params.role}-${index}`);
			const agentId = loopName;
			const taskFile = path.join(RALPH_DIR, `${loopName}.md`);
			const taskContent = buildSwarmAgentTaskContent(run, params.role, params.taskContent, mode, allowedPaths, ownedPaths);
			const fullPath = path.resolve(ctx.cwd, taskFile);
			ensureDir(fullPath);
			fs.writeFileSync(fullPath, taskContent, "utf-8");

			const load = cognitiveLoad(ctx, run);
			const autoQueue = (params.autoQueue ?? true) && load.level !== "critical";
			const loopState: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: params.maxIterations ?? 20,
				itemsPerIteration: params.itemsPerIteration ?? 2,
				reflectEvery: params.reflectEvery ?? 5,
				reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
				active: autoQueue,
				status: autoQueue ? "active" : "paused",
				startedAt: nowIso(),
				lastReflectionAt: 0,
			};
			saveState(ctx, loopState);

			const agent: SwarmAgent = {
				id: agentId,
				runId: run.id,
				role: params.role,
				mode,
				loopName,
				taskFile,
				status: autoQueue ? "active" : "paused",
				allowedPaths,
				ownedPaths,
				dependencies: params.dependencies ?? [],
				maxIterations: loopState.maxIterations,
				itemsPerIteration: loopState.itemsPerIteration,
				reflectEvery: loopState.reflectEvery,
				createdAt: nowIso(),
				updatedAt: nowIso(),
			};
			saveSwarmAgent(ctx, agent);
			run.agentIds.push(agent.id);
			saveSwarmRun(ctx, run);
			currentSwarm = run.id;

			if (autoQueue) {
				currentLoop = loopName;
				pi.sendUserMessage(buildPrompt(loopState, taskContent, false), {
					deliverAs: "followUp",
					streamingBehavior: "followUp",
				});
			}
			updateUI(ctx);
			const queueNote = autoQueue ? "queued first iteration" : "created paused because autoQueue=false or load is critical";
			return { content: [{ type: "text", text: `${agent.id}: ${queueNote}\n${renderSwarmBoard(ctx, run)}` }], details: { agentId: agent.id } };
		},
	});

	pi.registerTool({
		name: "swarm_status",
		label: "Swarm Status",
		description: "Return the swarm board and cognitive-load report.",
		parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const run = loadTargetSwarmRun(ctx, params.runId);
			return { content: [{ type: "text", text: run ? renderSwarmBoard(ctx, run) : "No swarm run found." }], details: {} };
		},
	});

	pi.registerTool({
		name: "swarm_list_agents",
		label: "List Swarm Agents",
		description: "List agents for a swarm run with statuses and loop names.",
		parameters: Type.Object({ runId: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const run = loadSwarmRun(ctx, params.runId);
			if (!run) return { content: [{ type: "text", text: `Swarm run not found: ${params.runId}` }], details: {} };
			const agents = listSwarmAgents(ctx, run.id).map((agent) => syncSwarmAgentFromLoop(ctx, agent));
			const text = agents.length
				? agents.map((agent) => `${agent.id}: ${agent.status}, ${agent.mode}, loop=${agent.loopName}`).join("\n")
				: `No agents for swarm ${run.id}.`;
			return { content: [{ type: "text", text }], details: { count: agents.length } };
		},
	});

	pi.registerTool({
		name: "swarm_cognitive_load",
		label: "Swarm Cognitive Load",
		description: "Return the cognitive-load report for a swarm run.",
		parameters: Type.Object({ runId: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const run = loadSwarmRun(ctx, params.runId);
			if (!run) return { content: [{ type: "text", text: `Swarm run not found: ${params.runId}` }], details: {} };
			const load = cognitiveLoad(ctx, run);
			const text = `Load: ${load.level} (${load.score})\nActive agents: ${load.activeAgents}\nWriter agents: ${load.writerAgents}\nBlocked agents: ${load.blockedAgents}\nBudget agents: ${load.budgetAgents}/${run.maxAgents} non-terminal (${load.totalAgents} total)\nReasons: ${load.reasons.join(", ")}`;
			return { content: [{ type: "text", text }], details: load };
		},
	});

	pi.registerTool({
		name: "swarm_advise",
		label: "Swarm Advisor",
		description: "Return manager-side recommendations from swarm state without spawning an advisor agent.",
		parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const run = loadTargetSwarmRun(ctx, params.runId);
			if (!run) return { content: [{ type: "text", text: "No swarm run found." }], details: {} };
			const advice = adviseSwarm(ctx, run);
			return { content: [{ type: "text", text: renderSwarmAdvice(advice) }], details: advice };
		},
	});

	pi.registerTool({
		name: "swarm_collect",
		label: "Collect Swarm Agent",
		description: "Collect a swarm agent's Ralph state and task-file evidence.",
		parameters: Type.Object({ agentId: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = loadSwarmAgent(ctx, params.agentId);
			if (!agent) return { content: [{ type: "text", text: `Agent not found: ${params.agentId}` }], details: {} };
			const synced = syncSwarmAgentFromLoop(ctx, agent);
			const task = tryRead(path.resolve(ctx.cwd, synced.taskFile)) || "";
			return {
				content: [{ type: "text", text: `Agent: ${synced.id}\nStatus: ${synced.status}\nLoop: ${synced.loopName}\n\n${task}` }],
				details: { agentId: synced.id, status: synced.status },
			};
		},
	});

	pi.registerTool({
		name: "swarm_list_queue",
		label: "List Swarm Queue",
		description: "List CLI-created swarm prompt queue records awaiting Pi/Ralph delivery.",
		parameters: Type.Object({
			runId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			status: Type.Optional(Type.Union([Type.Literal("queued"), Type.Literal("delivered"), Type.Literal("stale"), Type.Literal("failed")])),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const records = listSwarmQueueRecords(ctx, {
				runId: params.runId,
				agentId: params.agentId,
				status: params.status as SwarmQueueStatus | undefined,
			});
			return { content: [{ type: "text", text: renderSwarmQueue(records) }], details: { count: records.length } };
		},
	});

	pi.registerTool({
		name: "swarm_drain_queue",
		label: "Drain Swarm Queue",
		description: "Deliver queued swarm prompts into Pi/Ralph follow-up messages. Stops when Pi already has a pending message.",
		parameters: Type.Object({
			runId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ description: "Maximum queued prompts to deliver", default: 1 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const records = listSwarmQueueRecords(ctx, { runId: params.runId, agentId: params.agentId, status: "queued" });
			const limit = Math.max(1, params.limit ?? 1);
			const results: string[] = [];
			for (const record of records.slice(0, limit)) {
				const result = deliverQueuedSwarmPrompt(ctx, record);
				results.push(result);
				if (result.includes("pending Pi messages") || result.includes("delivered")) break;
			}
			return {
				content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No queued swarm prompts." }],
				details: { delivered: results.filter((result) => result.includes("delivered")).length, checked: results.length },
			};
		},
	});

	pi.registerTool({
		name: "swarm_advance_agent",
		label: "Advance Swarm Agent",
		description: "Advance a Ralph-backed swarm agent to its next iteration.",
		parameters: Type.Object({ agentId: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = loadSwarmAgent(ctx, params.agentId);
			if (!agent) return { content: [{ type: "text", text: `Agent not found: ${params.agentId}` }], details: {} };
			const result = advanceRalphLoop(ctx, agent.loopName);
			syncSwarmAgentFromLoop(ctx, agent);
			return { content: [{ type: "text", text: result }], details: { agentId: agent.id } };
		},
	});

	pi.registerTool({
		name: "swarm_pause_agent",
		label: "Pause Swarm Agent",
		description: "Pause a Ralph-backed swarm agent without deleting its task evidence.",
		parameters: Type.Object({ agentId: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = loadSwarmAgent(ctx, params.agentId);
			if (!agent) return { content: [{ type: "text", text: `Agent not found: ${params.agentId}` }], details: {} };
			const loop = loadState(ctx, agent.loopName);
			if (loop && loop.status === "active") pauseLoop(ctx, loop, `Paused swarm agent: ${agent.id}`);
			agent.status = "paused";
			saveSwarmAgent(ctx, agent);
			updateUI(ctx);
			return { content: [{ type: "text", text: `Paused swarm agent: ${agent.id}` }], details: { agentId: agent.id } };
		},
	});

	pi.registerTool({
		name: "swarm_continue_agent",
		label: "Continue Swarm Agent",
		description: "Append a new iteration to a completed Ralph-backed swarm agent and optionally queue the prompt.",
		parameters: Type.Object({
			agentId: Type.String(),
			activate: Type.Optional(Type.Boolean({ description: "Queue the continuation prompt immediately", default: true })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = loadSwarmAgent(ctx, params.agentId);
			if (!agent) return { content: [{ type: "text", text: `Agent not found: ${params.agentId}` }], details: {} };
			const result = continueSwarmAgent(ctx, agent, params.activate ?? true);
			updateUI(ctx);
			return { content: [{ type: "text", text: result }], details: { agentId: agent.id } };
		},
	});

	pi.registerTool({
		name: "swarm_cancel_agent",
		label: "Cancel Swarm Agent",
		description: "Mark a swarm agent cancelled while preserving its task file and evidence.",
		parameters: Type.Object({ agentId: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = loadSwarmAgent(ctx, params.agentId);
			if (!agent) return { content: [{ type: "text", text: `Agent not found: ${params.agentId}` }], details: {} };
			const loop = loadState(ctx, agent.loopName);
			if (loop && loop.status === "active") pauseLoop(ctx, loop);
			agent.status = "cancelled";
			saveSwarmAgent(ctx, agent);
			updateUI(ctx);
			return { content: [{ type: "text", text: `Cancelled swarm agent: ${agent.id}` }], details: { agentId: agent.id } };
		},
	});

	pi.registerTool({
		name: "swarm_record_decision",
		label: "Record Swarm Decision",
		description: "Record an integration decision for the current swarm run.",
		parameters: Type.Object({
			runId: Type.String(),
			decision: Type.String(),
			rationale: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const run = loadSwarmRun(ctx, params.runId);
			if (!run) return { content: [{ type: "text", text: `Swarm run not found: ${params.runId}` }], details: {} };
			run.decisions.push({ text: params.decision, rationale: params.rationale, createdAt: nowIso() });
			saveSwarmRun(ctx, run);
			updateUI(ctx);
			return { content: [{ type: "text", text: `Recorded decision for ${run.id}: ${params.decision}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "swarm_record_blocker",
		label: "Record Swarm Blocker",
		description: "Record a blocker that should raise cognitive load and pause risky spawning.",
		parameters: Type.Object({
			runId: Type.String(),
			blocker: Type.String(),
			neededDecision: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const run = loadSwarmRun(ctx, params.runId);
			if (!run) return { content: [{ type: "text", text: `Swarm run not found: ${params.runId}` }], details: {} };
			run.blockers.push({ text: params.blocker, neededDecision: params.neededDecision, createdAt: nowIso() });
			saveSwarmRun(ctx, run);
			updateUI(ctx);
			return { content: [{ type: "text", text: `Recorded blocker for ${run.id}: ${params.blocker}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "swarm_escalate",
		label: "Escalate Swarm Issue",
		description: "Create a durable escalation record for orchestrator review. High severity blocks the agent by default.",
		parameters: Type.Object({
			agentId: Type.String(),
			question: Type.String(),
			severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
			context: Type.Optional(Type.String()),
			evidenceFiles: Type.Optional(Type.Array(Type.String())),
			recommendedOptions: Type.Optional(Type.Array(Type.String())),
			needsOrchestratorDecision: Type.Optional(Type.Boolean({ default: true })),
			pauseAgent: Type.Optional(Type.Boolean({ description: "Pause/block the agent after escalation. Defaults to true for high severity.", default: false })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = loadSwarmAgent(ctx, params.agentId);
			if (!agent) return { content: [{ type: "text", text: `Agent not found: ${params.agentId}` }], details: {} };
			const record = createSwarmEscalation(ctx, agent, {
				severity: params.severity as SwarmEscalationSeverity | undefined,
				question: params.question,
				context: params.context,
				evidenceFiles: params.evidenceFiles,
				recommendedOptions: params.recommendedOptions,
				needsOrchestratorDecision: params.needsOrchestratorDecision,
				pauseAgent: params.pauseAgent,
			});
			return { content: [{ type: "text", text: `Escalated ${record.id}: ${record.severity}\n${record.question}` }], details: { escalationId: record.id } };
		},
	});

	pi.registerTool({
		name: "swarm_list_escalations",
		label: "List Swarm Escalations",
		description: "List durable escalation records for orchestrator review.",
		parameters: Type.Object({
			runId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("resolved")])),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const records = listSwarmEscalationRecords(ctx, {
				runId: params.runId,
				agentId: params.agentId,
				status: params.status as SwarmEscalationStatus | undefined,
			});
			return { content: [{ type: "text", text: renderSwarmEscalations(records) }], details: { count: records.length } };
		},
	});

	pi.registerTool({
		name: "swarm_resolve_escalation",
		label: "Resolve Swarm Escalation",
		description: "Resolve an open swarm escalation and record the orchestrator decision.",
		parameters: Type.Object({
			escalationId: Type.String(),
			decision: Type.String(),
			resolutionNote: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const record = loadSwarmEscalationRecord(ctx, params.escalationId);
			if (!record) return { content: [{ type: "text", text: `Escalation not found: ${params.escalationId}` }], details: {} };
			const resolved = resolveSwarmEscalation(ctx, record, params.decision, params.resolutionNote);
			return { content: [{ type: "text", text: `Resolved escalation ${resolved.id}: ${params.decision}` }], details: { escalationId: resolved.id } };
		},
	});

	// Tool for agent to signal iteration complete and request next
	pi.registerTool({
		name: "ralph_done",
		label: "Ralph Iteration Done",
		description: "Signal that you've completed this iteration of the Ralph loop. Call this after making progress to get the next iteration prompt. Do NOT call this if you've output the completion marker.",
		promptSnippet: "Advance an active Ralph loop after completing the current iteration.",
		promptGuidelines: [
			"Call this after making real iteration progress so Ralph can queue the next prompt.",
			"Do not call this if there is no active loop, if pending messages are already queued, or if the completion marker has already been emitted.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Loop name to advance; defaults to current loop" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loopName = params.name ? sanitize(params.name) : currentLoop;
			if (!loopName) {
				return { content: [{ type: "text", text: "No active Ralph loop." }], details: {} };
			}

			const state = loadState(ctx, loopName);
			if (!state || state.status !== "active") {
				return { content: [{ type: "text", text: "Ralph loop is not active." }], details: {} };
			}

			if (ctx.hasPendingMessages()) {
				return {
					content: [{ type: "text", text: "Pending messages already queued. Skipping ralph_done." }],
					details: {},
				};
			}

			// Increment iteration
			state.iteration++;

			// Check max iterations
			if (state.maxIterations > 0 && state.iteration > state.maxIterations) {
				completeLoop(
					ctx,
					state,
					`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
				);
				return { content: [{ type: "text", text: "Max iterations reached. Loop stopped." }], details: {} };
			}

			const needsReflection = state.reflectEvery > 0 && (state.iteration - 1) % state.reflectEvery === 0;
			if (needsReflection) state.lastReflectionAt = state.iteration;

			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
			if (!content) {
				pauseLoop(ctx, state);
				return { content: [{ type: "text", text: `Error: Could not read task file: ${state.taskFile}` }], details: {} };
			}

			// Queue next iteration - use followUp so user can still interrupt
			pi.sendUserMessage(buildPrompt(state, content, needsReflection), {
				deliverAs: "followUp",
				streamingBehavior: "followUp",
			});

			return {
				content: [{ type: "text", text: `Iteration ${state.iteration - 1} complete. Next iteration queued.` }],
				details: {},
			};
		},
	});

	// --- Event handlers ---

	pi.on("before_agent_start", async (event, ctx) => {
		if (!currentLoop) return;
		const state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active") return;

		const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;

		let instructions = `You are in a Ralph loop working on: ${state.taskFile}\n`;
		instructions += `- Before doing work, reload .ralph/${state.name}.state.json; if status is completed, ignore this stale prompt and do not call ralph_done\n`;
		if (state.itemsPerIteration > 0) {
			instructions += `- Work on ~${state.itemsPerIteration} items this iteration\n`;
		}
		instructions += `- Update the task file as you progress\n`;
		instructions += `- Preserve artifacts needed by final verification\n`;
		instructions += `- Record an exact monitor-rerunnable final command before completion\n`;
		instructions += `- When FULLY COMPLETE and externally rerunnable: ${COMPLETE_MARKER}\n`;
		instructions += `- Otherwise, call ralph_done with {"name":"${state.name}"} to proceed to next iteration`;

		return {
			systemPrompt: event.systemPrompt + `\n[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!currentLoop) return;
		const state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active") return;

		// Check for completion marker
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		const text =
			lastAssistant && Array.isArray(lastAssistant.content)
				? lastAssistant.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
				: "";

		if (text.includes(COMPLETE_MARKER)) {
			completeLoop(
				ctx,
				state,
				`───────────────────────────────────────────────────────────────────────
✅ RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations
───────────────────────────────────────────────────────────────────────`,
			);
			return;
		}

		// Check max iterations
		if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
			completeLoop(
				ctx,
				state,
				`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
			);
			return;
		}

		// Don't auto-continue - let the agent call ralph_done to proceed
		// This allows user's "stop" message to be processed first
	});

	pi.on("session_start", async (_event, ctx) => {
		const active = listLoops(ctx).filter((l) => l.status === "active");
		const activeSwarms = listSwarmRuns(ctx).filter((run) => run.status === "active");

		// Rehydrate currentLoop from disk. The module is re-initialized on
		// session reload (including auto-compaction and /compact), which would
		// otherwise leave `currentLoop` null and silently break ralph_done,
		// agent_end, and before_agent_start. Pick the most-recently-updated
		// active loop when there are multiple, using the state file mtime.
		if (!currentLoop && active.length > 0) {
			const mostRecent = active.reduce((best, candidate) => {
				const bestMtime = safeMtimeMs(getPath(ctx, best.name, ".state.json"));
				const candidateMtime = safeMtimeMs(getPath(ctx, candidate.name, ".state.json"));
				return candidateMtime > bestMtime ? candidate : best;
			});
			currentLoop = mostRecent.name;
		}
		if (!currentSwarm && activeSwarms.length > 0) {
			currentSwarm = activeSwarms.reduce((best, candidate) => (candidate.updatedAt > best.updatedAt ? candidate : best)).id;
		}

		if (active.length > 0 && ctx.hasUI) {
			const lines = active.map(
				(l) => `  • ${l.name} (iteration ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations}` : ""})`,
			);
			ctx.ui.notify(`Active Ralph loops:\n${lines.join("\n")}\n\nUse /ralph resume <name> to continue`, "info");
		}
		if (activeSwarms.length > 0 && ctx.hasUI) {
			const lines = activeSwarms.map((run) => `  • ${run.id} (${cognitiveLoad(ctx, run).level})`);
			ctx.ui.notify(`Active swarms:\n${lines.join("\n")}\n\nUse /swarm status <name> to inspect`, "info");
		}
		updateUI(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (currentLoop) {
			const state = loadState(ctx, currentLoop);
			if (state) saveState(ctx, state);
		}
		if (currentSwarm) {
			const run = loadSwarmRun(ctx, currentSwarm);
			if (run) saveSwarmRun(ctx, run);
		}
	});
}
