import type { SupportedProvider } from "./schemas";

export interface SupportedChatModel {
	id: string;
	provider: SupportedProvider;
	label: string;
	contextWindow: number;
	maxOutputTokens: number;
	pricing: {
		inputUsdPerMillionTokens: number;
		cachedInputUsdPerMillionTokens?: number;
		outputUsdPerMillionTokens: number;
	};
}

export const supportedChatModels = [
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
] satisfies SupportedChatModel[];

export function findSupportedChatModel(modelId: string): SupportedChatModel | undefined {
	return supportedChatModels.find((model) => model.id === modelId);
}

export function getProviderForModel(modelId: string): SupportedProvider | undefined {
	return findSupportedChatModel(modelId)?.provider;
}

export type { SupportedProvider };
