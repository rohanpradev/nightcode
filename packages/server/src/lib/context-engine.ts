import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { estimateTokens } from "./cache";
import { logger } from "./logger";
import { isSensitivePath } from "./sensitive-path";
import { WorkspaceBoundary } from "./workspace-boundary";

// Types
export interface CodeSymbol {
	name: string;
	kind: "function" | "class" | "type" | "interface" | "variable" | "method" | "import" | "export";
	file: string;
	startLine: number;
	endLine: number;
	parent?: string;
	signature?: string;
}

export interface FileContext {
	path: string;
	content: string;
	relevanceScore: number;
	reason: string;
	tokens: number;
}

export interface ContextConfig {
	/** Max tokens available for context */
	maxTokens: number;
	/** Working directory */
	cwd: string;
	/** Files explicitly added by user */
	pinnedFiles: string[];
	/** Minimum relevance score to include */
	minRelevance: number;
}

export interface IndexDirectoryOptions {
	/** Largest source file read into the in-memory index. */
	maxFileBytes?: number;
	/** Maximum number of source files indexed for one workspace. */
	maxFiles?: number;
	/** Stop incremental scans promptly when the owning run is cancelled. */
	abortSignal?: AbortSignal;
}

export interface IndexFileOptions {
	/** Largest source file read into the in-memory index. */
	maxFileBytes?: number;
}

const DEFAULT_MAX_INDEX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_INDEX_FILES = 20_000;

// Repomap: Fast Symbol Index
type RepositoryState = {
	canonicalRoot: string;
	symbolIndex: Map<string, CodeSymbol[]>;
	fileModTimes: Map<string, number>;
};

const repositoryStates = new Map<string, RepositoryState>();

function repositoryKey(root = process.cwd()): string {
	const key = resolve(root);
	return process.platform === "win32" ? key.toLowerCase() : key;
}

function repositoryState(root = process.cwd()): RepositoryState {
	const key = repositoryKey(root);
	const existing = repositoryStates.get(key);
	if (existing) return existing;
	const created = {
		canonicalRoot: resolve(root),
		symbolIndex: new Map<string, CodeSymbol[]>(),
		fileModTimes: new Map<string, number>(),
	};
	repositoryStates.set(key, created);
	return created;
}

export function clearRepositoryIndex(root = process.cwd()): void {
	repositoryStates.delete(repositoryKey(root));
}

function normalizePathSeparators(path: string): string {
	return path.replace(/\\/g, "/");
}

function normalizePathForComparison(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinRoot(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." &&
			!pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
			!isAbsolute(pathFromRoot))
	);
}

function samePath(left: string, right: string): boolean {
	return normalizePathForComparison(left) === normalizePathForComparison(right);
}

function removeIndexedPath(state: RepositoryState, path: string): void {
	for (const indexedPath of state.symbolIndex.keys()) {
		if (!samePath(indexedPath, path)) continue;
		state.symbolIndex.delete(indexedPath);
		state.fileModTimes.delete(indexedPath);
	}
}

function workspaceRelativePath(state: RepositoryState, filePath: string): string | null {
	if (!isWithinRoot(state.canonicalRoot, filePath)) return null;
	const pathFromRoot = relative(state.canonicalRoot, filePath);
	return normalizePathSeparators(pathFromRoot);
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

type IndexableFile = {
	canonicalPath: string;
	modifiedAt: number;
};

async function resolveIndexableFile(
	filePath: string,
	canonicalRoot: string,
	maxFileBytes: number,
): Promise<IndexableFile | null> {
	try {
		const canonicalPath = await realpath(filePath);
		if (!isWithinRoot(canonicalRoot, canonicalPath)) return null;
		if (isSensitivePath(canonicalPath)) return null;

		const info = await stat(canonicalPath);
		if (!info.isFile() || info.size > maxFileBytes) return null;

		return { canonicalPath, modifiedAt: info.mtimeMs };
	} catch {
		return null;
	}
}

/** Extract symbols from TypeScript/JavaScript using regex (fast, no tree-sitter needed) */
export function extractSymbols(content: string, filePath: string): CodeSymbol[] {
	const symbols: CodeSymbol[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();

		// Functions
		const fnMatch = trimmed.match(
			/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
		);
		const fnName = fnMatch?.[1];
		if (fnName) {
			const endLine = findBlockEnd(lines, i);
			symbols.push({
				name: fnName,
				kind: "function",
				file: filePath,
				startLine: i + 1,
				endLine,
				signature: trimmed.split("(")[0]?.trim(),
			});
		}

		// Arrow functions & const declarations
		const arrowMatch = trimmed.match(
			/^(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
		);
		const arrowName = arrowMatch?.[1];
		if (arrowName) {
			symbols.push({
				name: arrowName,
				kind: "function",
				file: filePath,
				startLine: i + 1,
				endLine: findBlockEnd(lines, i),
				signature: trimmed.split("=")[0]?.trim(),
			});
		}

		// Classes
		const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
		const className = classMatch?.[1];
		if (className) {
			symbols.push({
				name: className,
				kind: "class",
				file: filePath,
				startLine: i + 1,
				endLine: findBlockEnd(lines, i),
			});
		}

		// Interfaces
		const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
		const ifaceName = ifaceMatch?.[1];
		if (ifaceName) {
			symbols.push({
				name: ifaceName,
				kind: "interface",
				file: filePath,
				startLine: i + 1,
				endLine: findBlockEnd(lines, i),
			});
		}

		// Type aliases
		const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/);
		const typeName = typeMatch?.[1];
		if (typeName) {
			symbols.push({
				name: typeName,
				kind: "type",
				file: filePath,
				startLine: i + 1,
				endLine: findStatementEnd(lines, i),
			});
		}

		// Methods (inside classes)
		const methodMatch = trimmed.match(
			/(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/,
		);
		const methodName = methodMatch?.[1];
		if (
			methodName &&
			!fnMatch &&
			!trimmed.startsWith("if") &&
			!trimmed.startsWith("for") &&
			!trimmed.startsWith("while")
		) {
			symbols.push({
				name: methodName,
				kind: "method",
				file: filePath,
				startLine: i + 1,
				endLine: findBlockEnd(lines, i),
			});
		}
	}

	return symbols;
}

/** Find the end of a code block (matching braces) */
function findBlockEnd(lines: string[], startIdx: number): number {
	let depth = 0;
	let found = false;

	for (let i = startIdx; i < Math.min(lines.length, startIdx + 500); i++) {
		const line = lines[i] ?? "";
		for (const char of line) {
			if (char === "{") {
				depth++;
				found = true;
			} else if (char === "}") {
				depth--;
				if (depth === 0 && found) return i + 1;
			}
		}
	}

	return startIdx + 1;
}

/** Find end of a statement (semicolon or type boundary) */
function findStatementEnd(lines: string[], startIdx: number): number {
	for (let i = startIdx; i < Math.min(lines.length, startIdx + 50); i++) {
		if (lines[i]?.includes(";")) return i + 1;
	}

	return startIdx + 1;
}

async function indexResolvedFile(
	candidate: IndexableFile,
	state: RepositoryState,
	maxFileBytes: number,
): Promise<{ indexed: boolean; symbols: CodeSymbol[] }> {
	try {
		const file = Bun.file(candidate.canonicalPath);
		if (!(await file.exists()) || file.size > maxFileBytes) {
			removeIndexedPath(state, candidate.canonicalPath);
			return { indexed: false, symbols: [] };
		}

		const bytes = await file.slice(0, maxFileBytes + 1).arrayBuffer();
		if (bytes.byteLength > maxFileBytes) {
			removeIndexedPath(state, candidate.canonicalPath);
			return { indexed: false, symbols: [] };
		}
		const content = new TextDecoder().decode(bytes);
		const symbols = extractSymbols(content, candidate.canonicalPath);

		state.symbolIndex.set(candidate.canonicalPath, symbols);
		state.fileModTimes.set(candidate.canonicalPath, candidate.modifiedAt);

		return { indexed: true, symbols };
	} catch {
		removeIndexedPath(state, candidate.canonicalPath);
		return { indexed: false, symbols: [] };
	}
}

/** Index a file's symbols after verifying its canonical path stays inside the workspace. */
export async function indexFile(
	filePath: string,
	root = process.cwd(),
	options: IndexFileOptions = {},
): Promise<CodeSymbol[]> {
	const state = repositoryState(root);
	const maxFileBytes = boundedPositiveInteger(options.maxFileBytes, DEFAULT_MAX_INDEX_FILE_BYTES);

	try {
		state.canonicalRoot = await realpath(root);
	} catch {
		removeIndexedPath(state, filePath);
		return [];
	}

	const candidate = await resolveIndexableFile(filePath, state.canonicalRoot, maxFileBytes);
	if (!candidate) {
		removeIndexedPath(state, filePath);
		return [];
	}

	return (await indexResolvedFile(candidate, state, maxFileBytes)).symbols;
}

/** Index entire directory */
export async function indexDirectory(
	dirPath: string,
	options: IndexDirectoryOptions = {},
): Promise<number> {
	clearRepositoryIndex(dirPath);
	return refreshRepositoryIndex(dirPath, options);
}

/** Incrementally refresh changed files and remove deleted entries. */
export async function refreshRepositoryIndex(
	dirPath: string,
	options: IndexDirectoryOptions = {},
): Promise<number> {
	const state = repositoryState(dirPath);
	const maxFileBytes = boundedPositiveInteger(options.maxFileBytes, DEFAULT_MAX_INDEX_FILE_BYTES);
	const maxFiles = boundedPositiveInteger(options.maxFiles, DEFAULT_MAX_INDEX_FILES);

	try {
		state.canonicalRoot = await realpath(dirPath);
	} catch {
		return 0;
	}

	const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cts}");
	const excluded = new Set(["node_modules", ".git", "dist", ".next", "coverage", ".bun", ".cache"]);
	let indexed = 0;
	const seenCanonicalPaths = new Set<string>();

	for await (const file of glob.scan({ cwd: dirPath, onlyFiles: true })) {
		if (options.abortSignal?.aborted) {
			throw options.abortSignal.reason ?? new Error("repository indexing aborted");
		}
		if (indexed >= maxFiles) break;
		const parts = normalizePathSeparators(file).split("/");
		if (parts.some((p) => excluded.has(p))) continue;

		const candidate = await resolveIndexableFile(
			resolve(dirPath, file),
			state.canonicalRoot,
			maxFileBytes,
		);
		if (!candidate) continue;

		const canonicalKey = normalizePathForComparison(candidate.canonicalPath);
		if (seenCanonicalPaths.has(canonicalKey)) continue;
		seenCanonicalPaths.add(canonicalKey);

		if (state.fileModTimes.get(candidate.canonicalPath) !== candidate.modifiedAt) {
			const result = await indexResolvedFile(candidate, state, maxFileBytes);
			if (!result.indexed) continue;
		}
		indexed++;
	}
	for (const indexedPath of [...state.symbolIndex.keys()]) {
		if (seenCanonicalPaths.has(normalizePathForComparison(indexedPath))) continue;
		state.symbolIndex.delete(indexedPath);
		state.fileModTimes.delete(indexedPath);
	}

	logger.debug(`Refreshed ${indexed} files, ${getSymbolCount(dirPath)} symbols (dir: ${dirPath})`);

	return indexed;
}

export function getSymbolCount(root = process.cwd()): number {
	let count = 0;
	for (const symbols of repositoryState(root).symbolIndex.values()) {
		count += symbols.length;
	}
	return count;
}

/** Find symbols by name (fuzzy) */
export function findSymbols(
	query: string,
	kind?: CodeSymbol["kind"],
	root = process.cwd(),
): CodeSymbol[] {
	const results: CodeSymbol[] = [];
	const lower = query.toLowerCase();

	for (const symbols of repositoryState(root).symbolIndex.values()) {
		for (const sym of symbols) {
			if (kind && sym.kind !== kind) continue;
			if (sym.name.toLowerCase().includes(lower)) {
				results.push(sym);
			}
		}
	}

	return results.sort((a, b) => {
		// Exact match first
		if (a.name === query) return -1;
		if (b.name === query) return 1;

		// Then by starts-with
		if (a.name.startsWith(query) && !b.name.startsWith(query)) return -1;
		if (b.name.startsWith(query) && !a.name.startsWith(query)) return 1;

		return a.name.length - b.name.length;
	});
}

// Context Ranking

function stablePathCompare(left: string, right: string): number {
	const normalizedLeft = normalizePathSeparators(left);
	const normalizedRight = normalizePathSeparators(right);
	const foldedLeft = normalizedLeft.toLowerCase();
	const foldedRight = normalizedRight.toLowerCase();

	if (foldedLeft < foldedRight) return -1;
	if (foldedLeft > foldedRight) return 1;
	if (normalizedLeft < normalizedRight) return -1;
	if (normalizedLeft > normalizedRight) return 1;
	return 0;
}

function scoreQueryRelevance(
	filePath: string,
	query: string,
	symbols: CodeSymbol[],
): { score: number; reason: string } {
	let score = 0;
	const reasons = new Set<string>();

	const lowerQuery = normalizePathSeparators(query).trim().toLowerCase();
	if (!lowerQuery) return { score: 0, reason: "none" };

	const lowerPath = normalizePathSeparators(filePath).toLowerCase();
	const pathParts = lowerPath.split("/");
	const fileName = pathParts[pathParts.length - 1] ?? "";

	if (lowerPath.includes(lowerQuery)) {
		score += 0.5;
		reasons.add("path-match");
	}

	if (fileName.includes(lowerQuery)) {
		score += 0.3;
		reasons.add("filename-match");
	}

	const queryWords = lowerQuery.split(/[\s/_.-]+/).filter((word) => word.length >= 3);
	for (const word of queryWords) {
		if (lowerPath.includes(word)) {
			score += 0.1;
			reasons.add(`path:${word}`);
		}
		if (fileName.includes(word)) {
			score += 0.1;
			reasons.add(`filename:${word}`);
		}
	}

	for (const sym of symbols) {
		for (const word of queryWords) {
			if (sym.name.toLowerCase().includes(word)) {
				score += 0.2;
				reasons.add(`symbol:${sym.name}`);
				break;
			}
		}
	}

	if (
		score > 0 &&
		(lowerPath.includes(".test.") || lowerPath.includes(".spec.")) &&
		!queryWords.includes("test") &&
		!queryWords.includes("spec")
	) {
		score *= 0.5;
	}

	if (score > 0 && fileName.startsWith("index.")) {
		score += 0.1;
	}

	return { score: Math.min(score, 1), reason: [...reasons].join(",") || "none" };
}

/** Score a file's relevance to a query, with recency as a secondary signal. */
function scoreFileRelevance(
	filePath: string,
	query: string,
	symbols: CodeSymbol[],
	fileModTimes: Map<string, number>,
	relativePath = filePath,
): { score: number; reason: string } {
	const relevance = scoreQueryRelevance(relativePath, query, symbols);
	let score = relevance.score;

	// Recency bonus
	const modTime = fileModTimes.get(filePath);
	if (modTime) {
		const age = Date.now() - modTime;

		if (age < 60_000) {
			score += 0.3; // Modified in last minute
		} else if (age < 300_000) {
			score += 0.2; // Modified in last 5 minutes
		} else if (age < 3_600_000) {
			score += 0.1; // Modified in last hour
		}
	}

	return { score: Math.min(score, 1), reason: relevance.reason };
}

// Context Assembly

/**
 * Assemble the best code context for a user query within a token budget.
 * Returns ranked file contexts that fit within the budget.
 */
export async function assembleContext(
	query: string,
	config: ContextConfig,
): Promise<FileContext[]> {
	const timer = logger.startTimer("context-assembly");
	const results: FileContext[] = [];
	let tokensUsed = 0;
	const state = repositoryState(config.cwd);
	const maxTokens = Number.isFinite(config.maxTokens)
		? Math.min(1_000_000, Math.max(0, Math.floor(config.maxTokens)))
		: 0;
	const boundary = new WorkspaceBoundary(config.cwd);
	const included = new Set<string>();

	const include = async (path: string, relevanceScore: number, reason: string) => {
		if (tokensUsed >= maxTokens || isSensitivePath(path)) return;
		try {
			// Index entries and pins can be stale or replaced by links between runs.
			const authorized = await boundary.authorize(path, "read");
			if (!authorized.exists || isSensitivePath(authorized.canonicalPath)) return;
			const key = normalizePathForComparison(authorized.canonicalPath);
			if (included.has(key)) return;
			const maxChars = Math.min(
				DEFAULT_MAX_INDEX_FILE_BYTES,
				Math.floor((maxTokens - tokensUsed) * 3.5),
			);
			const file = Bun.file(authorized.canonicalPath);
			const maxBytes = Math.min(file.size, maxChars * 4 + 4);
			let content = await file.slice(0, maxBytes).text();
			if (content.length > maxChars || maxBytes < file.size) {
				const marker = "\n[truncated; re-read file for more]";
				if (maxChars < marker.length) return;
				const prefix = content.slice(0, maxChars - marker.length).replace(/[\uD800-\uDBFF]$/, "");
				content = `${prefix}${marker}`;
			}
			const tokens = estimateTokens(content);
			if (tokensUsed + tokens > maxTokens) return;
			results.push({
				path: authorized.canonicalPath,
				content,
				relevanceScore,
				reason,
				tokens,
			});
			included.add(key);
			tokensUsed += tokens;
		} catch {}
	};

	// Pins have priority, but never grant access or bypass the context budget.
	for (const pinnedPath of config.pinnedFiles) {
		await include(pinnedPath, 1, "pinned");
	}

	// 2. Score all indexed files
	const candidates: Array<{ path: string; score: number; reason: string }> = [];

	for (const [filePath, symbols] of state.symbolIndex) {
		if (included.has(normalizePathForComparison(filePath))) continue;

		const { score, reason } = scoreFileRelevance(
			filePath,
			query,
			symbols,
			state.fileModTimes,
			relative(config.cwd, filePath),
		);

		if (score >= config.minRelevance) {
			candidates.push({ path: filePath, score, reason });
		}
	}

	// 3. Sort by relevance and fill token budget
	candidates.sort((a, b) => b.score - a.score || stablePathCompare(a.path, b.path));

	for (const candidate of candidates) {
		if (tokensUsed >= maxTokens) break;
		await include(candidate.path, candidate.score, candidate.reason);
	}

	timer.stop({ filesIncluded: results.length, tokensUsed });

	return results;
}

/** Generate a repomap summary (like Aider) - concise file/symbol listing. */
export function generateRepomap(maxTokens = 4000, root = process.cwd(), query?: string): string {
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) return "";
	const maxChars = Math.floor(maxTokens) * 3.5;
	let map = "# Repository Map\n";
	if (map.length > maxChars) return "";
	const state = repositoryState(root);
	const hasQuery = Boolean(query?.trim());
	const files = [...state.symbolIndex.entries()]
		.map(([filePath, symbols]) => {
			const relativePath = workspaceRelativePath(state, filePath);
			if (relativePath === null) return null;

			return {
				filePath,
				relativePath,
				symbols,
				queryScore: hasQuery ? scoreQueryRelevance(relativePath, query ?? "", symbols).score : 0,
			};
		})
		.filter((file): file is NonNullable<typeof file> => file !== null)
		.sort((a, b) => {
			if (hasQuery && b.queryScore !== a.queryScore) return b.queryScore - a.queryScore;

			const aTime = state.fileModTimes.get(a.filePath) ?? 0;
			const bTime = state.fileModTimes.get(b.filePath) ?? 0;
			return bTime - aTime || stablePathCompare(a.relativePath, b.relativePath);
		});

	for (const { relativePath, symbols } of files) {
		if (map.length >= maxChars) break;

		const fileHeader = `\n## ${relativePath}`;
		const symLines = symbols
			.filter((s) => s.kind !== "method")
			.map((s) => `${s.kind}: ${s.name}${s.signature ? ` ${s.signature}` : ""}`)
			.join("\n");

		const entry = `\n${fileHeader}\n${symLines}`;

		if (map.length + entry.length > maxChars) continue;

		map += entry;
	}

	return map;
}

// Context Window Management

/**
 * Omit old conversation messages with an explicit note; this is not a summary.
 * Presentation notices do not consume the recent conversation allowance.
 */
export function compactMessages(
	messages: Array<{ role: string; content: string }>,
	keepLast: number = 6,
	// Retained for callers of the former summarization API; no summary is generated.
	_maxSummaryTokens: number = 2000,
): Array<{ role: string; content: string }> {
	messages = messages.filter((message) => message.role !== "notice" && message.role !== "system");
	keepLast = Number.isFinite(keepLast) ? Math.max(1, Math.floor(keepLast)) : 6;
	if (messages.length <= keepLast) return messages;

	const omitted = messages.slice(0, messages.length - keepLast);
	const retained = messages.slice(messages.length - keepLast);

	const omittedTokens = omitted.reduce(
		(total, message) => total + estimateTokens(message.content),
		0,
	);
	const note = {
		role: "user" as const,
		content: [
			"<context-note>",
			`${omitted.length} earlier messages (${omittedTokens.toLocaleString()} estimated tokens) were omitted by local compact mode.`,
			"Do not infer their exact contents. Re-read repository state or ask the user when missing details matter.",
			"</context-note>",
		].join("\n"),
	};

	return [note, ...retained];
}
