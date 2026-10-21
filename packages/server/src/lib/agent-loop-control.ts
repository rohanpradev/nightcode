import type { ModelMessage, StepResult, ToolSet } from "ai";

const READ_ONLY_TOOLS = new Set([
	"getTaskPlan",
	"readFile",
	"readLines",
	"listFiles",
	"fileInfo",
	"glob",
	"grep",
	"searchSymbols",
	"listAgentProfiles",
	"loadAgentProfile",
	"listSkills",
	"loadSkill",
	"listLspServers",
]);
const COMPACTION_NOTICE =
	"[Local context compaction omitted older assistant/tool exchanges. All user messages and recent exchanges are retained. Omitted tool outputs are unavailable; inspect the current workspace before relying on those details.]";

type LoopStep = Pick<StepResult<ToolSet>, "toolCalls" | "content">;
export type LoopStopReason = "step-limit" | "no-progress";

function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (item instanceof Error) return { name: item.name, message: item.message };
		if (item && typeof item === "object" && !Array.isArray(item)) {
			return Object.fromEntries(
				Object.keys(item)
					.sort()
					.map((key) => [key, item[key]]),
			);
		}
		return item;
	});
}

function stagnantFingerprint(step: LoopStep): string | undefined {
	if (step.toolCalls.length === 0) return undefined;
	const fingerprints: string[] = [];
	for (const call of step.toolCalls) {
		const result = step.content.find(
			(part) =>
				(part.type === "tool-result" || part.type === "tool-error") &&
				part.toolCallId === call.toolCallId,
		);
		if (!result || (result.type !== "tool-error" && result.type !== "tool-result")) {
			return undefined;
		}
		if (result.type !== "tool-error" && !READ_ONLY_TOOLS.has(call.toolName)) {
			// A successful mutation, command or unknown MCP tool may change state
			// even when its acknowledgement text stays identical.
			return undefined;
		}
		fingerprints.push(
			canonical({
				name: call.toolName,
				input: call.input,
				type: result.type,
				output: result.type === "tool-error" ? result.error : result.output,
			}),
		);
	}
	return canonical(fingerprints.sort());
}

/** Only identical, completed reads or failures count as stalled work. */
export function createLoopControl(maxSteps: number, repeatedStepLimit = 4) {
	let stopReason: LoopStopReason | undefined;
	return {
		get stopReason() {
			return stopReason;
		},
		stopWhen: ({ steps }: { steps: LoopStep[] }): boolean => {
			const recent = steps.slice(-repeatedStepLimit);
			const first = recent[0];
			if (recent.length === repeatedStepLimit && first) {
				const fingerprint = stagnantFingerprint(first);
				if (fingerprint && recent.every((step) => stagnantFingerprint(step) === fingerprint)) {
					stopReason = "no-progress";
					return true;
				}
			}
			if (steps.length >= maxSteps) {
				stopReason = "step-limit";
				return true;
			}
			return false;
		},
	};
}

export function estimateLoopTokens(value: unknown): number {
	// A conservative estimate for code and non-ASCII output; budget calculation
	// separately leaves model headroom because this is not a provider tokenizer.
	return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") / 3);
}

export function loopHistoryBudget(options: {
	contextWindow: number;
	maxOutputTokens: number;
	instructions: string | undefined;
	toolSchemaTokens: number;
}): number {
	return Math.max(
		0,
		Math.floor(options.contextWindow * 0.8) -
			options.maxOutputTokens -
			estimateLoopTokens(options.instructions) -
			options.toolSchemaTokens -
			1_024,
	);
}

export class ContextBudgetExceededError extends Error {
	readonly code = "CONTEXT_BUDGET_EXCEEDED";
	constructor() {
		super(
			"The user messages and recent tool exchanges exceed the model context budget. Start a new conversation or reduce the supplied context.",
		);
	}
}

/**
 * Remove whole old exchanges, never individual calls/results or user messages.
 * Shared tool/approval IDs join exchanges, including deferred provider results.
 */
export function compactLoopMessages(messages: ModelMessage[], maxTokens: number): ModelMessage[] {
	if (estimateLoopTokens(messages) <= maxTokens) return messages;
	const groups: Array<{ start: number; end: number; protected: boolean }> = [];
	const owners = new Map<string, number>();
	const spans: Array<[number, number]> = [];
	const pendingCalls = new Map<string, number>();
	const pendingApprovals = new Map<string, number>();
	const approvalCalls = new Map<string, string>();
	for (const [index, message] of messages.entries()) {
		const previousGroup = groups.at(-1);
		if (message.role === "tool" && previousGroup) {
			previousGroup.end = index + 1;
		} else {
			groups.push({
				start: index,
				end: index + 1,
				protected: message.role === "user" || message.role === "system",
			});
		}
		const group = groups.length - 1;
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (part.type === "tool-call") pendingCalls.set(part.toolCallId, group);
			if (part.type === "tool-result") pendingCalls.delete(part.toolCallId);
			if (part.type === "tool-approval-request") {
				pendingApprovals.set(part.approvalId, group);
				approvalCalls.set(part.approvalId, part.toolCallId);
			}
			if (part.type === "tool-approval-response") {
				pendingApprovals.delete(part.approvalId);
				const callId = approvalCalls.get(part.approvalId);
				if (!part.approved && callId) pendingCalls.delete(callId);
			}
			const identities: string[] = [];
			if ("toolCallId" in part) identities.push(`tool:${part.toolCallId}`);
			if ("approvalId" in part) identities.push(`approval:${part.approvalId}`);
			for (const id of identities) {
				const owner = owners.get(id);
				if (owner === undefined) owners.set(id, group);
				else if (owner !== group) spans.push([owner, group]);
			}
		}
	}
	for (const group of [...pendingCalls.values(), ...pendingApprovals.values()]) {
		const pending = groups[group];
		if (pending) pending.protected = true;
	}
	// Join overlapping dependency spans, so completed approval/deferred chains
	// can eventually age out without ever leaving orphaned calls or responses.
	const ends = groups.map((_group, index) => index);
	for (const [first, last] of spans) ends[first] = Math.max(ends[first] ?? first, last);
	const exchanges: typeof groups = [];
	for (let index = 0; index < groups.length; index++) {
		const firstGroup = groups[index];
		if (!firstGroup) continue;
		const exchange = { ...firstGroup };
		let last = ends[index] ?? index;
		while (index < last) {
			index++;
			const nextGroup = groups[index];
			if (!nextGroup) break;
			last = Math.max(last, ends[index] ?? index);
			exchange.end = nextGroup.end;
			exchange.protected ||= nextGroup.protected;
		}
		exchanges.push(exchange);
	}
	const recent = exchanges.filter((group) => messages[group.start]?.role === "assistant").slice(-2);
	for (const group of recent) group.protected = true;
	const kept = new Set(messages.map((_message, index) => index));
	const notice: ModelMessage = { role: "assistant", content: COMPACTION_NOTICE };
	let tokens =
		messages.reduce((sum, message) => sum + estimateLoopTokens(message) + 1, 0) +
		estimateLoopTokens(notice) +
		4;
	for (const group of exchanges) {
		if (group.protected) continue;
		for (let index = group.start; index < group.end; index++) {
			kept.delete(index);
			tokens -= estimateLoopTokens(messages[index]) + 1;
		}
		if (tokens <= maxTokens) break;
	}
	const compacted = messages.filter((_message, index) => kept.has(index));
	// Keep the first user turn ahead of the compaction notice. The marker has no
	// tool data and does not promote untrusted tool output to assistant authority.
	const insertion = compacted.findIndex((message) => message.role === "user") + 1;
	compacted.splice(insertion, 0, notice);
	if (estimateLoopTokens(compacted) > maxTokens) throw new ContextBudgetExceededError();
	return compacted;
}
