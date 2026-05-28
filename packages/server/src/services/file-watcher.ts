import { type FSWatcher, watch } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger";

export type FileChangeEvent = {
	root: string;
	path: string;
	event: "rename" | "change";
};

export class FileWatcherService {
	#watchers = new Map<string, FSWatcher>();
	#subscribers = new Set<(event: FileChangeEvent) => void>();

	watch(root: string): void {
		const resolvedRoot = resolve(root);
		if (this.#watchers.has(resolvedRoot)) return;

		try {
			const watcher = watch(resolvedRoot, { recursive: true }, (eventType, filename) => {
				if (!filename) return;
				const event = {
					root: resolvedRoot,
					path: resolve(resolvedRoot, filename.toString()),
					event: eventType,
				} satisfies FileChangeEvent;

				for (const subscriber of this.#subscribers) subscriber(event);
			});

			this.#watchers.set(resolvedRoot, watcher);
			logger.debug("watching files", { root: resolvedRoot });
		} catch (error) {
			logger.warn("failed to watch files", {
				root: resolvedRoot,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	onChange(subscriber: (event: FileChangeEvent) => void): () => void {
		this.#subscribers.add(subscriber);
		return () => this.#subscribers.delete(subscriber);
	}

	close(root?: string): void {
		if (root) {
			const resolvedRoot = resolve(root);
			this.#watchers.get(resolvedRoot)?.close();
			this.#watchers.delete(resolvedRoot);
			return;
		}

		for (const watcher of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
	}
}

export const fileWatcher = new FileWatcherService();
