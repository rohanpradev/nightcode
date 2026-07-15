import { z } from "zod";

export const supportedProviderSchema = z.enum(["openai", "anthropic", "azure"]);

export const llmMessageSchema = z.object({
	// `notice` is presentation-only state. It is persisted with a session but is
	// never sent to a model, which keeps CLI diagnostics out of the trusted
	// instruction channel.
	role: z.enum(["system", "user", "assistant", "notice"]),
	content: z.string(),
});

export const approvalModeSchema = z.enum(["always", "on-risk", "never"]);

export const reasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh"]);

export const llmConfigSchema = z.object({
	provider: supportedProviderSchema.default("openai"),
	model: z.string().default("gpt-5.6"),
	maxTokens: z.number().int().positive().default(8192),
	temperature: z.number().min(0).max(2).default(0.2),
	systemPrompt: z.string().optional(),
	agentMode: z.boolean().default(true),
	reasoningEffort: reasoningEffortSchema.optional(),
	approvalMode: approvalModeSchema.default("on-risk"),
});

export const chatRequestSchema = z.object({
	messages: z.array(llmMessageSchema).min(1),
	config: llmConfigSchema.partial().optional(),
	sessionId: z.string().min(1).max(120).optional(),
	workspace: z.string().min(1).optional(),
});

const usageSchema = z.object({
	inputTokens: z.number().int().nonnegative().optional(),
	outputTokens: z.number().int().nonnegative().optional(),
	totalTokens: z.number().int().nonnegative().optional(),
	reasoningTokens: z.number().int().nonnegative().optional(),
	cachedInputTokens: z.number().int().nonnegative().optional(),
});

const streamMetadataSchema = z.object({
	runId: z.string().optional(),
	sequence: z.number().int().nonnegative().optional(),
	timestamp: z.string().optional(),
});

export const llmStreamChunkSchema = z.discriminatedUnion("type", [
	streamMetadataSchema.extend({
		type: z.literal("run-start"),
		version: z.literal(1),
		sessionId: z.string(),
		workspace: z.string(),
	}),
	streamMetadataSchema.extend({
		type: z.literal("step-start"),
		step: z.number().int().nonnegative(),
	}),
	z.object({
		type: z.literal("text"),
		text: z.string(),
		runId: z.string().optional(),
		sequence: z.number().int().nonnegative().optional(),
		timestamp: z.string().optional(),
	}),
	z.object({
		type: z.literal("tool-call"),
		toolCall: z.object({
			id: z.string().optional(),
			name: z.string(),
			args: z.record(z.string(), z.unknown()),
		}),
		runId: z.string().optional(),
		sequence: z.number().int().nonnegative().optional(),
		timestamp: z.string().optional(),
	}),
	z.object({
		type: z.literal("tool-result"),
		toolResult: z.object({
			id: z.string().optional(),
			toolCallId: z.string().optional(),
			name: z.string(),
			result: z.string(),
			isError: z.boolean().optional(),
		}),
		runId: z.string().optional(),
		sequence: z.number().int().nonnegative().optional(),
		timestamp: z.string().optional(),
	}),
	streamMetadataSchema.extend({
		type: z.literal("approval-request"),
		approval: z.object({
			id: z.string(),
			toolCallId: z.string(),
			toolName: z.string(),
			args: z.record(z.string(), z.unknown()),
			reason: z.string().optional(),
		}),
	}),
	streamMetadataSchema.extend({
		type: z.literal("approval-response"),
		approval: z.object({
			id: z.string(),
			approved: z.boolean(),
			reason: z.string().optional(),
		}),
	}),
	streamMetadataSchema.extend({
		type: z.literal("step-finish"),
		step: z.number().int().nonnegative(),
		finishReason: z.string(),
		usage: usageSchema.optional(),
	}),
	streamMetadataSchema.extend({
		type: z.literal("aborted"),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("error"),
		error: z.string(),
		code: z.string().optional(),
		retryable: z.boolean().optional(),
		runId: z.string().optional(),
		sequence: z.number().int().nonnegative().optional(),
		timestamp: z.string().optional(),
	}),
	z.object({
		type: z.literal("done"),
		finishReason: z.string().optional(),
		usage: usageSchema.optional(),
		runId: z.string().optional(),
		sequence: z.number().int().nonnegative().optional(),
		timestamp: z.string().optional(),
	}),
]);

export const approvalDecisionSchema = z.object({
	approvalId: z.string().min(1),
	approved: z.boolean(),
	reason: z.string().max(500).optional(),
});

export const approvalRequestSchema = z.object({
	sessionId: z.string().min(1).max(120),
	workspace: z.string().min(1).optional(),
	decision: approvalDecisionSchema,
});

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
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalMode = z.infer<typeof approvalModeSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
