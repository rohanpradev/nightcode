import type { AgentRunResult, LLMConfig, LLMMessage, LLMStreamChunk } from "@nightcode/shared";
import type { LLMService } from "./agent-runtime";
import { llm } from "./llm";

export interface AgentRunInput {
	messages: LLMMessage[];
	config?: Partial<LLMConfig>;
	sessionId?: string;
	abortSignal?: AbortSignal;
	onEvent?: (event: LLMStreamChunk) => void | Promise<void>;
}

export class CodingAgentService {
	constructor(private readonly service: LLMService = llm) {}

	async run(input: AgentRunInput): Promise<AgentRunResult> {
		const startedAt = Date.now();
		let text = "";
		let toolCalls = 0;
		let steps = 0;
		let approvalsRequired = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let totalTokens = 0;
		let reasoningTokens = 0;
		let cachedInputTokens = 0;
		let status: AgentRunResult["status"] = "failed";
		let finishReason: string | undefined;
		let error: string | undefined = "Agent stream ended without a terminal event.";

		let terminalFailure = false;
		try {
			for await (const chunk of this.service.stream(input.messages, input.config, {
				sessionId: input.sessionId,
				abortSignal: input.abortSignal,
			})) {
				await input.onEvent?.(chunk);
				if (chunk.type === "text") text += chunk.text;
				if (chunk.type === "tool-call") toolCalls++;
				if (chunk.type === "step-start") steps++;
				if (chunk.type === "approval-request") approvalsRequired++;
				if (chunk.type === "error") {
					terminalFailure = true;
					status = "failed";
					error = chunk.error;
				}
				if (chunk.type === "aborted") {
					terminalFailure = true;
					status = "aborted";
					error = chunk.reason;
				}
				if (chunk.type === "step-finish" && chunk.usage) {
					inputTokens += chunk.usage.inputTokens ?? 0;
					outputTokens += chunk.usage.outputTokens ?? 0;
					totalTokens +=
						chunk.usage.totalTokens ??
						(chunk.usage.inputTokens ?? 0) + (chunk.usage.outputTokens ?? 0);
					reasoningTokens += chunk.usage.reasoningTokens ?? 0;
					cachedInputTokens += chunk.usage.cachedInputTokens ?? 0;
				}
				if (chunk.type === "done" && chunk.usage) {
					// The terminal usage is an aggregate, not an additional step.
					inputTokens = chunk.usage.inputTokens ?? inputTokens;
					outputTokens = chunk.usage.outputTokens ?? outputTokens;
					totalTokens = chunk.usage.totalTokens ?? inputTokens + outputTokens;
					reasoningTokens = chunk.usage.reasoningTokens ?? reasoningTokens;
					cachedInputTokens = chunk.usage.cachedInputTokens ?? cachedInputTokens;
				}
				if (chunk.type === "done") {
					finishReason = chunk.finishReason;
					if (!terminalFailure) {
						if (chunk.finishReason === "approval-required") {
							status = "approval-required";
							error = undefined;
						} else if (chunk.finishReason === "stop") {
							status = "completed";
							error = undefined;
						} else {
							status = "failed";
							terminalFailure = true;
							error = `Agent did not complete: ${chunk.finishReason ?? "unknown finish reason"}`;
						}
					}
				}
			}
		} catch (cause) {
			status = input.abortSignal?.aborted ? "aborted" : "failed";
			error = cause instanceof Error ? cause.message : String(cause);
		}

		return {
			status,
			text,
			toolCalls,
			steps,
			approvalsRequired,
			durationMs: Date.now() - startedAt,
			finishReason,
			error,
			usage: {
				inputTokens,
				outputTokens,
				totalTokens,
				reasoningTokens,
				cachedInputTokens,
			},
		};
	}
}

export const codingAgent = new CodingAgentService();
