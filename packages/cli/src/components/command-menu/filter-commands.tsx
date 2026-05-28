import { COMMANDS } from "@cli/components/command-menu/commands";
import type { CommandItem } from "@cli/components/command-menu/types";

type ScoredCommand = { cmd: CommandItem; score: number };

/**
 * Fuzzy-match a query against a target string.
 * Returns a score > 0 if all characters in the query appear in order in the target.
 * Higher scores indicate better matches (prefix > contiguous > scattered).
 * Returns 0 for no match.
 */
function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (query.length > target.length) return 0;

	// Exact prefix gets highest score
	if (target.startsWith(query)) return 100 + (query.length / target.length) * 50;

	// Contiguous substring match
	const substringIndex = target.indexOf(query);
	if (substringIndex !== -1) return 70 + (query.length / target.length) * 20;

	// Fuzzy: all characters must appear in order
	let qi = 0;
	let consecutiveBonus = 0;
	let lastMatchIndex = -2;

	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (target[ti] === query[qi]) {
			if (ti === lastMatchIndex + 1) consecutiveBonus += 10;
			lastMatchIndex = ti;
			qi++;
		}
	}

	if (qi !== query.length) return 0; // Not all characters matched

	const baseScore = 30 + (query.length / target.length) * 20;
	return baseScore + consecutiveBonus;
}

export function filterCommands(query: string): CommandItem[] {
	if (!query) return COMMANDS;

	const q = query.toLowerCase().trim();
	if (!q) return COMMANDS;

	const scored: ScoredCommand[] = [];

	for (const cmd of COMMANDS) {
		const nameScore = fuzzyScore(q, cmd.name);
		const descScore = fuzzyScore(q, cmd.description.toLowerCase()) * 0.5;
		const bestScore = Math.max(nameScore, descScore);

		if (bestScore > 0) {
			scored.push({ cmd, score: bestScore });
		}
	}

	// Sort by score descending (best matches first)
	scored.sort((a, b) => b.score - a.score);

	return scored.map((s) => s.cmd);
}
