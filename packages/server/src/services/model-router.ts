import { createOpenAI } from "@ai-sdk/openai";
import type { LLMConfig, SupportedProvider } from "@nightcode/shared";
import { getProviderForModel, supportedChatModels } from "@nightcode/shared";
import type { LanguageModel } from "ai";
import { optionalEnv } from "../lib/env";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface ProviderHealth {
	provider: SupportedProvider;
	available: boolean;
	reason?: string;
}

export class ModelRouter {
	#openai = createOpenAI({
		apiKey: optionalEnv("OPENAI_API_KEY"),
		baseURL: optionalEnv("OPENAI_BASE_URL") ?? OPENAI_DEFAULT_BASE_URL,
		organization: optionalEnv("OPENAI_ORG_ID"),
		project: optionalEnv("OPENAI_PROJECT_ID"),
	});

	getAvailableProviders(): ProviderHealth[] {
		return [
			{
				provider: "openai",
				available: Boolean(optionalEnv("OPENAI_API_KEY")),
				reason: optionalEnv("OPENAI_API_KEY") ? undefined : "OPENAI_API_KEY is missing",
			},
			{
				provider: "anthropic",
				available: Boolean(process.env.ANTHROPIC_API_KEY),
				reason: process.env.ANTHROPIC_API_KEY
					? "provider dependency is installed but not routed yet"
					: "ANTHROPIC_API_KEY is missing",
			},
			{
				provider: "azure",
				available: Boolean(process.env.AZURE_API_KEY),
				reason: process.env.AZURE_API_KEY
					? "provider dependency is installed but not routed yet"
					: "AZURE_API_KEY is missing",
			},
		];
	}

	resolve(config: LLMConfig): LanguageModel {
		const provider = getProviderForModel(config.model) ?? config.provider;

		if (provider !== config.provider) {
			throw new Error(
				`Model ${config.model} belongs to ${provider}, but provider is ${config.provider}.`,
			);
		}

		if (provider === "openai") {
			if (!optionalEnv("OPENAI_API_KEY")) {
				throw new Error("OPENAI_API_KEY is required for the OpenAI provider.");
			}
			return this.#openai.responses(config.model);
		}

		throw new Error(`${provider} routing is not implemented yet.`);
	}

	listModels(provider?: SupportedProvider) {
		return provider
			? supportedChatModels.filter((model) => model.provider === provider)
			: supportedChatModels;
	}
}

export const modelRouter = new ModelRouter();
