import { resolve } from "node:path";
import { estimateTokens } from "./cache";
import { logger } from "./logger";

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

// Repomap: Fast Symbol Index
type RepositoryState = {
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
	const created = { symbolIndex: new Map(), fileModTimes: new Map() };
	repositoryStates.set(key, created);
	return created;
}

export function clearRepositoryIndex(root = process.cwd()): void {
	repositoryStates.delete(repositoryKey(root));
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

/** Index a file's symbols */
export async function indexFile(filePath: string, root = process.cwd()): Promise<CodeSymbol[]> {
	try {
		const file = Bun.file(filePath);
		const state = repositoryState(root);
		if (!(await file.exists())) {
			state.symbolIndex.delete(filePath);
			state.fileModTimes.delete(filePath);
			return [];
		}

		const content = await file.text();
		const symbols = extractSymbols(content, filePath);

		state.symbolIndex.set(filePath, symbols);
		state.fileModTimes.set(filePath, file.lastModified);

		return symbols;
	} catch {
		return [];
	}
}

/** Index entire directory */
export async function indexDirectory(dirPath: string): Promise<number> {
	clearRepositoryIndex(dirPath);
	const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cts}");
	const excluded = new Set(["node_modules", ".git", "dist", ".next", "coverage", ".bun", ".cache"]);

	let indexed = 0;

	for await (const file of glob.scan({ cwd: dirPath, onlyFiles: true })) {
		const parts = file.split("/");

		if (parts.some((p) => excluded.has(p))) continue;

		await indexFile(resolve(dirPath, file), dirPath);
		indexed++;
	}

	logger.info(`Indexed ${indexed} files, ${getSymbolCount(dirPath)} symbols (dir: ${dirPath})`);

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

/** Score a file's relevance to a query */
function scoreFileRelevance(
	filePath: string,
	query: string,
	symbols: CodeSymbol[],
	fileModTimes: Map<string, number>,
): { score: number; reason: string } {
	let score = 0;
	const reasons: string[] = [];

	const lowerQuery = query.toLowerCase();
	const lowerPath = filePath.toLowerCase();

	// Filename/path matching
	const pathParts = filePath.split("/");
	const fileName = pathParts[pathParts.length - 1] ?? "";

	if (lowerPath.includes(lowerQuery)) {
		score += 0.5;
		reasons.push("path-match");
	}

	if (fileName.toLowerCase().includes(lowerQuery)) {
		score += 0.3;
		reasons.push("filename-match");
	}

	// Symbol name matching
	const queryWords = lowerQuery.split(/\s+/);

	for (const sym of symbols) {
		for (const word of queryWords) {
			if (word.length < 3) continue;

			if (sym.name.toLowerCase().includes(word)) {
				score += 0.2;
				reasons.push(`symbol:${sym.name}`);
				break;
			}
		}
	}

	// File type relevance
	if (filePath.endsWith(".test.ts") || filePath.endsWith(".spec.ts")) {
		score *= 0.5; // Deprioritize test files unless explicitly searching for test
	}

	if (filePath.includes("index.")) {
		score += 0.1; // Index files are often important entry points
	}

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

	return { score: Math.min(score, 1), reason: reasons.join(",") || "none" };
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

	// 1. Always include pinned files first
	for (const pinnedPath of config.pinnedFiles) {
		try {
			const file = Bun.file(pinnedPath);
			if (!(await file.exists())) continue;

			const content = await file.text();
			const tokens = estimateTokens(content);

			results.push({
				path: pinnedPath,
				content,
				relevanceScore: 1.0,
				reason: "pinned",
				tokens,
			});

			tokensUsed += tokens;
		} catch {}
	}

	// 2. Score all indexed files
	const candidates: Array<{ path: string; score: number; reason: string }> = [];

	for (const [filePath, symbols] of state.symbolIndex) {
		if (config.pinnedFiles.includes(filePath)) continue;

		const { score, reason } = scoreFileRelevance(filePath, query, symbols, state.fileModTimes);

		if (score >= config.minRelevance) {
			candidates.push({ path: filePath, score, reason });
		}
	}

	// 3. Sort by relevance and fill token budget
	candidates.sort((a, b) => b.score - a.score);

	for (const candidate of candidates) {
		if (tokensUsed >= config.maxTokens) break;

		try {
			const file = Bun.file(candidate.path);
			const content = await file.text();
			const tokens = estimateTokens(content);

			if (tokensUsed + tokens > config.maxTokens) {
				// Try to include a truncated version
				const available = config.maxTokens - tokensUsed;

				if (available > 200) {
					const truncated = content.slice(0, available * 3); // ~3 chars per token

					results.push({
						path: candidate.path,
						content: `${truncated}\n\n[... truncated ...]`,
						relevanceScore: candidate.score,
						reason: candidate.reason,
						tokens: available,
					});

					tokensUsed += available;
				}

				continue;
			}

			results.push({
				path: candidate.path,
				content,
				relevanceScore: candidate.score,
				reason: candidate.reason,
				tokens,
			});

			tokensUsed += tokens;
		} catch {}
	}

	timer.stop({ filesIncluded: results.length, tokensUsed });

	return results;
}

/** Generate a repomap summary (like Aider) - concise file/symbol listing */
export function generateRepomap(maxTokens = 4000, root = process.cwd()): string {
	const lines: string[] = ["# Repository Map\n"];
	let tokens = 50;
	const state = repositoryState(root);

	// Sort files by recency
	const files = [...state.symbolIndex.entries()].sort((a, b) => {
		const aTime = state.fileModTimes.get(a[0]) ?? 0;
		const bTime = state.fileModTimes.get(b[0]) ?? 0;
		return bTime - aTime;
	});

	for (const [filePath, symbols] of files) {
		if (tokens >= maxTokens) break;

		const fileHeader = `\n## ${filePath}`;
		const symLines = symbols
			.filter((s) => s.kind !== "method")
			.map((s) => `${s.kind}: ${s.name}${s.signature ? ` ${s.signature}` : ""}`)
			.join("\n");

		const entry = `${fileHeader}\n${symLines}`;
		const entryTokens = estimateTokens(entry);

		if (tokens + entryTokens > maxTokens) break;

		lines.push(entry);
		tokens += entryTokens;
	}

	return lines.join("\n");
}

// Context Window Management

/**
 * Summarize old conversation messages to save context window space.
 * Keeps the last N messages intact and summarizes older ones.
 */
export function compactMessages(
	messages: Array<{ role: string; content: string }>,
	keepLast: number = 6,
	maxSummaryTokens: number = 2000,
): Array<{ role: string; content: string }> {
	if (messages.length <= keepLast) return messages;

	const toSummarize = messages.slice(0, messages.length - keepLast);
	const toKeep = messages.slice(messages.length - keepLast);

	const omittedTokens = toSummarize.reduce(
		(total, message) => total + estimateTokens(message.content),
		0,
	);
	const summary = {
		role: "user" as const,
		content: [
			"<context-note>",
			`${toSummarize.length} earlier messages (${Math.min(omittedTokens, maxSummaryTokens).toLocaleString()}+ estimated tokens) were omitted by local compact mode.`,
			"Do not infer their exact contents. Re-read repository state or ask the user when missing details matter.",
			"</context-note>",
		].join("\n"),
	};

	return [summary, ...toKeep];
}
