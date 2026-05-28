import { z } from "zod";

export const supportedProviderSchema = z.enum(["openai", "anthropic", "azure"]);

export const llmMessageSchema = z.object({
	role: z.enum(["system", "user", "assistant"]),
	content: z.string(),
});

export const llmConfigSchema = z.object({
	provider: supportedProviderSchema.default("openai"),
	model: z.string().default("gpt-5.2"),
	maxTokens: z.number().int().positive().default(8192),
	temperature: z.number().min(0).max(2).default(0.2),
	systemPrompt: z.string().optional(),
	agentMode: z.boolean().default(true),
});

export const chatRequestSchema = z.object({
	messages: z.array(llmMessageSchema).min(1),
	config: llmConfigSchema.partial().optional(),
});

export const llmStreamChunkSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("text"),
		text: z.string(),
	}),
	z.object({
		type: z.literal("tool-call"),
		toolCall: z.object({
			name: z.string(),
			args: z.record(z.string(), z.unknown()),
		}),
	}),
	z.object({
		type: z.literal("tool-result"),
		toolResult: z.object({
			name: z.string(),
			result: z.string(),
		}),
	}),
	z.object({
		type: z.literal("done"),
		usage: z
			.object({
				inputTokens: z.number().optional(),
				outputTokens: z.number().optional(),
			})
			.optional(),
	}),
]);

export const agentRunResultSchema = z.object({
	text: z.string(),
	toolCalls: z.number().int().nonnegative(),
	durationMs: z.number().int().nonnegative(),
	usage: z
		.object({
			inputTokens: z.number().int().nonnegative(),
			outputTokens: z.number().int().nonnegative(),
		})
		.optional(),
});

export type SupportedProvider = z.infer<typeof supportedProviderSchema>;
export type LLMMessage = z.infer<typeof llmMessageSchema>;
export type LLMConfigInput = z.input<typeof llmConfigSchema>;
export type LLMConfig = z.output<typeof llmConfigSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type LLMStreamChunk = z.infer<typeof llmStreamChunkSchema>;
export type AgentRunResult = z.infer<typeof agentRunResultSchema>;
