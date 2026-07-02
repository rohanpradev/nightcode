import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMConfig, SupportedProvider } from "@nightcode/shared";
import { getProviderForModel, supportedChatModels } from "@nightcode/shared";
import type { LanguageModel } from "ai";
import { optionalEnv } from "../lib/env";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

function anthropicAuthConfigured(): boolean {
	return Boolean(optionalEnv("ANTHROPIC_API_KEY") ?? optionalEnv("ANTHROPIC_AUTH_TOKEN"));
}

function azureApiKey(): string | undefined {
	return optionalEnv("AZURE_OPENAI_API_KEY") ?? optionalEnv("AZURE_API_KEY");
}

function azureBaseURL(): string | undefined {
	return optionalEnv("AZURE_OPENAI_BASE_URL") ?? optionalEnv("AZURE_BASE_URL");
}

function azureResourceName(): string | undefined {
	return optionalEnv("AZURE_OPENAI_RESOURCE_NAME") ?? optionalEnv("AZURE_RESOURCE_NAME");
}

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
	#anthropic = createAnthropic({
		apiKey: optionalEnv("ANTHROPIC_API_KEY"),
		authToken: optionalEnv("ANTHROPIC_AUTH_TOKEN"),
		baseURL: optionalEnv("ANTHROPIC_BASE_URL"),
	});
	#azure = createAzure({
		apiKey: azureApiKey(),
		baseURL: azureBaseURL(),
		resourceName: azureResourceName(),
		apiVersion: optionalEnv("AZURE_OPENAI_API_VERSION") ?? optionalEnv("AZURE_API_VERSION"),
	});

	getAvailableProviders(): ProviderHealth[] {
		const azureHasEndpoint = Boolean(azureBaseURL() ?? azureResourceName());
		return [
			{
				provider: "openai",
				available: Boolean(optionalEnv("OPENAI_API_KEY")),
				reason: optionalEnv("OPENAI_API_KEY") ? undefined : "OPENAI_API_KEY is missing",
			},
			{
				provider: "anthropic",
				available: anthropicAuthConfigured(),
				reason: anthropicAuthConfigured()
					? undefined
					: "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is missing",
			},
			{
				provider: "azure",
				available: Boolean(azureApiKey() && azureHasEndpoint),
				reason: !azureApiKey()
					? "AZURE_OPENAI_API_KEY or AZURE_API_KEY is missing"
					: azureHasEndpoint
						? undefined
						: "AZURE_OPENAI_RESOURCE_NAME or AZURE_OPENAI_BASE_URL is missing",
			},
		];
	}

	resolve(config: LLMConfig): LanguageModel {
		const catalogProvider = getProviderForModel(config.model);
		const provider = config.provider;

		if (catalogProvider && catalogProvider !== provider && provider !== "azure") {
			throw new Error(
				`Model ${config.model} belongs to ${catalogProvider}, but provider is ${provider}.`,
			);
		}

		if (provider === "openai") {
			if (!optionalEnv("OPENAI_API_KEY")) {
				throw new Error("OPENAI_API_KEY is required for the OpenAI provider.");
			}
			return this.#openai.responses(config.model);
		}

		if (provider === "anthropic") {
			if (!anthropicAuthConfigured()) {
				throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required.");
			}
			return this.#anthropic(config.model);
		}

		if (provider === "azure") {
			if (!azureApiKey()) {
				throw new Error("AZURE_OPENAI_API_KEY or AZURE_API_KEY is required.");
			}
			if (!azureBaseURL() && !azureResourceName()) {
				throw new Error("AZURE_OPENAI_RESOURCE_NAME or AZURE_OPENAI_BASE_URL is required.");
			}
			return this.#azure.responses(config.model);
		}

		throw new Error(`Unsupported provider: ${provider}`);
	}

	listModels(provider?: SupportedProvider) {
		return provider
			? supportedChatModels.filter((model) => model.provider === provider)
			: supportedChatModels;
	}
}

export const modelRouter = new ModelRouter();
