import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

async function workspaceKey(workspaceRoot: string): Promise<string> {
	const resolved = resolve(workspaceRoot);
	const canonical = await realpath(resolved).catch(() => resolved);
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	const message =
		reason instanceof Error
			? reason.message
			: typeof reason === "string" && reason
				? reason
				: "Workspace mutation was aborted.";
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

async function waitForTurn(predecessor: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await predecessor;
		return;
	}
	throwIfAborted(signal);
	await new Promise<void>((resolveTurn, rejectTurn) => {
		const onAbort = () => {
			cleanup();
			rejectTurn(abortError(signal));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		void predecessor.then(() => {
			cleanup();
			resolveTurn();
		});
	});
}

/** Serializes filesystem mutations across every runtime serving the same workspace. */
export class WorkspaceMutationCoordinator {
	#tails = new Map<string, Promise<void>>();

	async run<T>(
		workspaceRoot: string,
		operation: () => Promise<T>,
		abortSignal?: AbortSignal,
	): Promise<T> {
		throwIfAborted(abortSignal);
		const key = await workspaceKey(workspaceRoot);
		const predecessor = this.#tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const slot = new Promise<void>((resolveSlot) => {
			release = resolveSlot;
		});
		const tail = predecessor.then(() => slot);
		this.#tails.set(key, tail);
		void tail.then(() => {
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		});

		try {
			await waitForTurn(predecessor, abortSignal);
			throwIfAborted(abortSignal);
			return await operation();
		} finally {
			release();
		}
	}
}

export const workspaceMutationCoordinator = new WorkspaceMutationCoordinator();
