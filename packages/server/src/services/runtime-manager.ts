import { resolve } from "node:path";
import { createLLMService, type NightcodeLLMService } from "./agent-runtime";

type ManagedRuntime = {
	service: NightcodeLLMService;
	workspace: string;
	lastAccessedAt: number;
};

export interface RuntimeSession {
	id: string;
	workspace: string;
	lastAccessedAt: number;
	pendingApprovals: number;
	busy: boolean;
}

export interface RuntimeManagerOptions {
	maxSessions?: number;
	idleTtlMs?: number;
}

/**
 * Owns the stateful agent runtime boundary. A service is never shared across
 * session ids or silently moved to another workspace.
 */
export class RuntimeManager {
	readonly #sessions = new Map<string, ManagedRuntime>();
	readonly #maxSessions: number;
	readonly #idleTtlMs: number;

	constructor(options: RuntimeManagerOptions = {}) {
		this.#maxSessions = options.maxSessions ?? 100;
		this.#idleTtlMs = options.idleTtlMs ?? 2 * 60 * 60 * 1000;
	}

	getOrCreate(sessionId: string, workspace = process.cwd()): NightcodeLLMService {
		this.prune();
		const normalizedWorkspace = normalizePath(workspace);
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			if (normalizePath(existing.workspace) !== normalizedWorkspace) {
				throw new RuntimeSessionError(
					"SESSION_WORKSPACE_MISMATCH",
					`Session ${sessionId} belongs to ${existing.workspace}, not ${workspace}`,
				);
			}
			existing.lastAccessedAt = Date.now();
			return existing.service;
		}

		if (this.#sessions.size >= this.#maxSessions) this.#evictOldestIdle();
		if (this.#sessions.size >= this.#maxSessions) {
			throw new RuntimeSessionError(
				"SESSION_LIMIT_REACHED",
				`The runtime session limit (${this.#maxSessions}) has been reached`,
			);
		}

		const service = createLLMService({ workspaceRoot: normalizedWorkspace });
		this.#sessions.set(sessionId, {
			service,
			workspace: normalizedWorkspace,
			lastAccessedAt: Date.now(),
		});
		return service;
	}

	get(sessionId: string): NightcodeLLMService | undefined {
		const entry = this.#sessions.get(sessionId);
		if (entry) entry.lastAccessedAt = Date.now();
		return entry?.service;
	}

	delete(sessionId: string): boolean {
		return this.#sessions.delete(sessionId);
	}

	list(): RuntimeSession[] {
		return [...this.#sessions.entries()]
			.map(([id, entry]) => ({
				id,
				workspace: entry.workspace,
				lastAccessedAt: entry.lastAccessedAt,
				pendingApprovals: entry.service.getPendingApprovals().length,
				busy: entry.service.isBusy,
			}))
			.sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
	}

	prune(now = Date.now()): number {
		let removed = 0;
		for (const [id, entry] of this.#sessions) {
			if (
				now - entry.lastAccessedAt > this.#idleTtlMs &&
				entry.service.getPendingApprovals().length === 0 &&
				!entry.service.isBusy
			) {
				this.#sessions.delete(id);
				removed++;
			}
		}
		return removed;
	}

	#evictOldestIdle(): void {
		const oldest = [...this.#sessions.entries()]
			.filter(
				([, entry]) => entry.service.getPendingApprovals().length === 0 && !entry.service.isBusy,
			)
			.sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)[0];
		if (oldest) this.#sessions.delete(oldest[0]);
	}
}

export class RuntimeSessionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RuntimeSessionError";
	}
}

function normalizePath(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export const runtimeManager = new RuntimeManager();
