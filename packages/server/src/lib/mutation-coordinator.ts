import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function workspaceKey(workspaceRoot: string): string {
	const resolved = resolve(workspaceRoot);
	let cursor = resolved;
	while (true) {
		try {
			const canonical = resolve(realpathSync(cursor), relative(cursor, resolved));
			return process.platform === "win32" ? canonical.toLowerCase() : canonical;
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			cursor = parent;
		}
	}
}

function contains(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

type MutationReservation = { roots: string[]; done: Promise<void> };

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

/** Reserves all roots together, preserving FIFO order wherever their paths overlap. */
export class WorkspaceMutationCoordinator {
	#reservations = new Set<MutationReservation>();

	async run<T>(
		workspaceRoots: string | readonly string[],
		operation: () => Promise<T>,
		abortSignal?: AbortSignal,
	): Promise<T> {
		throwIfAborted(abortSignal);
		// Resolve synchronously so concurrent callers reserve their FIFO slots in
		// invocation order instead of racing asynchronous realpath operations.
		const roots = [
			...new Set(
				(typeof workspaceRoots === "string" ? [workspaceRoots] : workspaceRoots).map(workspaceKey),
			),
		];
		if (roots.length === 0) throw new Error("A mutation requires at least one workspace root.");
		const conflicts = [...this.#reservations].filter((reservation) =>
			reservation.roots.some((existing) =>
				roots.some((root) => contains(existing, root) || contains(root, existing)),
			),
		);
		const predecessor = Promise.all(conflicts.map((reservation) => reservation.done)).then(
			() => undefined,
		);
		let release!: () => void;
		const slot = new Promise<void>((resolveSlot) => {
			release = resolveSlot;
		});
		const tail = predecessor.then(() => slot);
		const reservation = { roots, done: tail };
		this.#reservations.add(reservation);
		void tail.then(() => this.#reservations.delete(reservation));

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
