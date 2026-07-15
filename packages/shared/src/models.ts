import type { SupportedProvider } from "./schemas";

export interface SupportedChatModel {
	id: string;
	provider: SupportedProvider;
	label: string;
	contextWindow: number;
	maxOutputTokens: number;
	defaultForProvider?: boolean;
	pricing?: {
		inputUsdPerMillionTokens: number;
		cachedInputUsdPerMillionTokens?: number;
		outputUsdPerMillionTokens: number;
	};
}

export const supportedChatModels = [
	{
		id: "gpt-5.6",
		provider: "openai",
		label: "GPT-5.6 Sol",
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		defaultForProvider: true,
		pricing: {
			inputUsdPerMillionTokens: 5,
			cachedInputUsdPerMillionTokens: 0.5,
			outputUsdPerMillionTokens: 30,
		},
	},
	{
		id: "gpt-5.6-sol",
		provider: "openai",
		label: "GPT-5.6 Sol",
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 5,
			cachedInputUsdPerMillionTokens: 0.5,
			outputUsdPerMillionTokens: 30,
		},
	},
	{
		id: "gpt-5.6-terra",
		provider: "openai",
		label: "GPT-5.6 Terra",
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 2.5,
			cachedInputUsdPerMillionTokens: 0.25,
			outputUsdPerMillionTokens: 15,
		},
	},
	{
		id: "gpt-5.6-luna",
		provider: "openai",
		label: "GPT-5.6 Luna",
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 1,
			cachedInputUsdPerMillionTokens: 0.1,
			outputUsdPerMillionTokens: 6,
		},
	},
	{
		id: "gpt-5.5",
		provider: "openai",
		label: "GPT-5.5",
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 5,
			cachedInputUsdPerMillionTokens: 0.5,
			outputUsdPerMillionTokens: 30,
		},
	},
	{
		id: "gpt-5.5-2026-04-23",
		provider: "openai",
		label: "GPT-5.5 (2026-04-23)",
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
	},
	{
		id: "gpt-5.4",
		provider: "openai",
		label: "GPT-5.4",
		contextWindow: 1_050_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 2.5,
			cachedInputUsdPerMillionTokens: 0.25,
			outputUsdPerMillionTokens: 15,
		},
	},
	{
		id: "gpt-5.4-mini",
		provider: "openai",
		label: "GPT-5.4 mini",
		contextWindow: 400_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 0.75,
			cachedInputUsdPerMillionTokens: 0.075,
			outputUsdPerMillionTokens: 4.5,
		},
	},
	{
		id: "gpt-5.4-nano",
		provider: "openai",
		label: "GPT-5.4 nano",
		contextWindow: 400_000,
		maxOutputTokens: 128_000,
	},
	{
		id: "gpt-5.3-codex",
		provider: "openai",
		label: "GPT-5.3 Codex",
		contextWindow: 400_000,
		maxOutputTokens: 128_000,
	},
	{
		id: "gpt-5.2",
		provider: "openai",
		label: "GPT-5.2",
		contextWindow: 400_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 1.75,
			cachedInputUsdPerMillionTokens: 0.175,
			outputUsdPerMillionTokens: 14,
		},
	},
	{
		id: "gpt-5.2-codex",
		provider: "openai",
		label: "GPT-5.2 Codex",
		contextWindow: 400_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 1.75,
			cachedInputUsdPerMillionTokens: 0.175,
			outputUsdPerMillionTokens: 14,
		},
	},
	{
		id: "gpt-5.1",
		provider: "openai",
		label: "GPT-5.1",
		contextWindow: 400_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 1.25,
			cachedInputUsdPerMillionTokens: 0.125,
			outputUsdPerMillionTokens: 10,
		},
	},
	{
		id: "gpt-5-mini",
		provider: "openai",
		label: "GPT-5 mini",
		contextWindow: 400_000,
		maxOutputTokens: 128_000,
		pricing: {
			inputUsdPerMillionTokens: 0.25,
			cachedInputUsdPerMillionTokens: 0.025,
			outputUsdPerMillionTokens: 2,
		},
	},
	{
		id: "gpt-4.1",
		provider: "openai",
		label: "GPT-4.1",
		contextWindow: 1_047_576,
		maxOutputTokens: 32_768,
		pricing: {
			inputUsdPerMillionTokens: 2,
			cachedInputUsdPerMillionTokens: 0.5,
			outputUsdPerMillionTokens: 8,
		},
	},
	{
		id: "claude-opus-4-7",
		provider: "anthropic",
		label: "Claude Opus 4.7",
		contextWindow: 200_000,
		maxOutputTokens: 32_000,
	},
	{
		id: "claude-opus-4-6",
		provider: "anthropic",
		label: "Claude Opus 4.6",
		contextWindow: 200_000,
		maxOutputTokens: 32_000,
	},
	{
		id: "claude-sonnet-4-6",
		provider: "anthropic",
		label: "Claude Sonnet 4.6",
		contextWindow: 200_000,
		maxOutputTokens: 32_000,
		defaultForProvider: true,
	},
	{
		id: "claude-sonnet-4-5",
		provider: "anthropic",
		label: "Claude Sonnet 4.5",
		contextWindow: 200_000,
		maxOutputTokens: 32_000,
	},
	{
		id: "claude-haiku-4-5",
		provider: "anthropic",
		label: "Claude Haiku 4.5",
		contextWindow: 200_000,
		maxOutputTokens: 32_000,
	},
] satisfies SupportedChatModel[];

export function findSupportedChatModel(modelId: string): SupportedChatModel | undefined {
	return supportedChatModels.find((model) => model.id === modelId);
}

export function getProviderForModel(modelId: string): SupportedProvider | undefined {
	return findSupportedChatModel(modelId)?.provider;
}

export function getDefaultModelForProvider(provider: SupportedProvider): string | undefined {
	return (
		supportedChatModels.find((model) => model.provider === provider && model.defaultForProvider)
			?.id ?? supportedChatModels.find((model) => model.provider === provider)?.id
	);
}

export type { SupportedProvider };
