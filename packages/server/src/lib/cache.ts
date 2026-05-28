interface CacheEntry<T> {
	value: T;
	expiresAt: number;
	accessedAt: number;
	size: number;
}

export class LRUCache<T> {
	private map = new Map<string, CacheEntry<T>>();
	private currentSize = 0;

	constructor(
		private readonly maxSize: number,
		private readonly defaultTTLMs: number,
	) {}

	get(key: string): T | undefined {
		const entry = this.map.get(key);
		if (!entry) {
			return undefined;
		}
		if (Date.now() > entry.expiresAt) {
			this.delete(key);
			return undefined;
		}
		entry.accessedAt = Date.now();
		return entry.value;
	}

	set(key: string, value: T, ttlMs?: number, size = 1): void {
		this.delete(key);
		this.evictIfNeeded(size);
		const entry: CacheEntry<T> = {
			value,
			expiresAt: Date.now() + (ttlMs ?? this.defaultTTLMs),
			accessedAt: Date.now(),
			size,
		};
		this.map.set(key, entry);
		this.currentSize += size;
	}

	delete(key: string): boolean {
		const entry = this.map.get(key);
		if (!entry) return false;

		this.map.delete(key);
		this.currentSize -= entry.size;
		return true;
	}

	has(key: string): boolean {
		const entry = this.map.get(key);
		if (!entry) {
			return false;
		}
		if (Date.now() > entry.expiresAt) {
			this.delete(key);
			return false;
		}
		return true;
	}

	clear(): void {
		this.map.clear();
		this.currentSize = 0;
	}

	get size(): number {
		return this.map.size;
	}

	get stats() {
		return {
			entries: this.map.size,
			currentSize: this.currentSize,
			maxSize: this.maxSize,
			utilization: this.currentSize / this.maxSize,
		};
	}

	invalidatePrefix(prefix: string): number {
		let count = 0;
		for (const key of this.map.keys()) {
			if (key.startsWith(prefix)) {
				this.delete(key);
				count++;
			}
		}
		return count;
	}

	private evictIfNeeded(size: number): void {
		if (this.currentSize + size <= this.maxSize) {
			return;
		}
		const entries = [...this.map.entries()].sort((a, b) => a[1].accessedAt - b[1].accessedAt);
		for (const [key] of entries) {
			this.delete(key);
			if (this.currentSize + size <= this.maxSize) {
				break;
			}
		}
	}
}

export const toolCache = new LRUCache<string>(500, 30_000); // 100MB max size, 1 hour TTL
export const tokenCache = new LRUCache<number>(1000, 300_000); // 100MB max size, 1 hour TTL
export const contextCache = new LRUCache<string[]>(50, 60_000); // 100MB max size, 1 hour TTL

export function hashKey(...parts: string[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const part of parts) {
		hasher.update(part);
	}
	return hasher.digest("hex").slice(0, 16);
}

export function toolCacheKey(toolName: string, args: Record<string, unknown>): string {
	return hashKey(toolName, JSON.stringify(args));
}

const watchedPaths = new Set<string>();
const watchers: Map<string, ReturnType<typeof import("node:fs").watch>> = new Map();

export function invalidateForPath(filePath: string): void {
	toolCache.invalidatePrefix(hashKey("readFile", filePath));
	toolCache.invalidatePrefix(hashKey("readLines", filePath));

	const dir = filePath.split("/").slice(0, -1).join("/");
	toolCache.invalidatePrefix(hashKey("listFiles", dir));
	toolCache.invalidatePrefix(hashKey("glob"));
	toolCache.invalidatePrefix(hashKey("grep"));
}

export function watchDirectory(dirPath: string): void {
	if (watchedPaths.has(dirPath)) {
		return;
	}
	watchedPaths.add(dirPath);
	try {
		const { watch } = require("node:fs");
		const watcher = watch(
			dirPath,
			{ recursive: true },
			(_eventType: string, filename: string | null) => {
				if (filename) {
					invalidateForPath(`${dirPath}/${filename}`);
				}
			},
		);
		watchers.set(dirPath, watcher);
	} catch {}
}

export function stopWatching(): void {
	for (const watcher of watchers.values()) {
		watcher.close();
	}
	watchers.clear();
	watchedPaths.clear();
}

export function estimateTokens(text: string): number {
	const key = hashKey(text);
	const cached = tokenCache.get(key);
	if (cached !== undefined) return cached;

	const estimate = Math.ceil(text.length / 3.5);
	tokenCache.set(key, estimate);
	return estimate;
}

export function getCacheStats() {
	return {
		toolCache: toolCache.stats,
		tokenCache: tokenCache.stats,
		contextCache: contextCache.stats,
	};
}
