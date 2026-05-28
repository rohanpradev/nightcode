import type { AgentRunResult, LLMConfig, LLMMessage } from "@nightcode/shared";
import { llm } from "./llm";

export interface AgentRunInput {
	messages: LLMMessage[];
	config?: Partial<LLMConfig>;
}

export class CodingAgentService {
	async run(input: AgentRunInput): Promise<AgentRunResult> {
		const startedAt = Date.now();
		let text = "";
		let toolCalls = 0;
		let inputTokens = 0;
		let outputTokens = 0;

		for await (const chunk of llm.stream(input.messages, input.config)) {
			if (chunk.type === "text") text += chunk.text;
			if (chunk.type === "tool-call") toolCalls++;
			if (chunk.type === "done" && chunk.usage) {
				inputTokens += chunk.usage.inputTokens ?? 0;
				outputTokens += chunk.usage.outputTokens ?? 0;
			}
		}

		return {
			text,
			toolCalls,
			durationMs: Date.now() - startedAt,
			usage: { inputTokens, outputTokens },
		};
	}
}

export const codingAgent = new CodingAgentService();
