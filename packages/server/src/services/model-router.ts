// Load trusted user configuration before the AI SDK's Gateway provider is used.
import "../lib/env";
import type { LLMConfig, SupportedProvider } from "@nightcode/shared";
import {
	findSupportedChatModel,
	getProviderForModel,
	supportedChatModels,
} from "@nightcode/shared";
import { gateway, type LanguageModel } from "ai";
import { z } from "zod";
import { optionalEnv } from "../lib/env";

export interface ProviderHealth {
	provider: SupportedProvider;
	available: boolean;
	reason?: string;
}

export interface GatewayModel {
	id: string;
	provider: string;
	label: string;
	contextWindow?: number;
	maxOutputTokens?: number;
}

export interface ModelLimits {
	contextWindow: number;
	maxOutputTokens: number;
}

const gatewayModelsSchema = z.object({ data: z.array(z.unknown()) });
const gatewayModelSchema = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[^\s/]+(?:\/[^\s/]+)*$/i),
	name: z.unknown().optional(),
	type: z.literal("language"),
	context_window: z.unknown().optional(),
	max_tokens: z.unknown().optional(),
});

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const MODEL_CACHE_MS = 5 * 60 * 1000;
const FALLBACK_MODEL_LIMITS: ModelLimits = { contextWindow: 32_768, maxOutputTokens: 8_192 };

function tokenLimit(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function waitForCatalog<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return request;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		request.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function gatewayAuthConfigured(): boolean {
	return Boolean(optionalEnv("AI_GATEWAY_API_KEY") ?? optionalEnv("VERCEL_OIDC_TOKEN"));
}

function toGatewayModelId(provider: string, model: string): string {
	const slash = model.indexOf("/");
	const namespace = slash < 0 ? provider : model.slice(0, slash);
	const id = slash < 0 ? model : model.slice(slash + 1);
	const shortModel = namespace === "openai" && id === "gpt-5.6" ? "gpt-5.6-sol" : id;
	const normalizedModel = shortModel.replace(/(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)/, "$1.$2");
	return `${namespace}/${normalizedModel}`;
}

export class ModelRouter {
	#modelCache: { expiresAt: number; models: GatewayModel[] } | undefined;
	#modelRequest: Promise<GatewayModel[]> | undefined;

	getAvailableProviders(): ProviderHealth[] {
		const available = gatewayAuthConfigured();
		return (["openai", "anthropic"] as const).map((provider) => ({
			provider,
			available,
			reason: available ? undefined : "AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is missing",
		}));
	}

	resolve(config: LLMConfig): LanguageModel {
		if (config.provider === "azure") {
			throw new Error(
				"Direct Azure deployments are no longer supported. Select openai or anthropic and a Vercel AI Gateway model ID.",
			);
		}
		const catalogProvider = getProviderForModel(config.model);
		if (catalogProvider && catalogProvider !== config.provider) {
			throw new Error(
				`Model ${config.model} belongs to ${catalogProvider}, but provider is ${config.provider}.`,
			);
		}
		if (!gatewayAuthConfigured()) {
			throw new Error("AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required for Vercel AI Gateway.");
		}

		// Gateway model IDs use provider/model. Keep accepting the CLI's existing
		// short model IDs and config files while sending fully qualified IDs upstream.
		return gateway(toGatewayModelId(config.provider, config.model));
	}

	async listModels(provider?: SupportedProvider): Promise<GatewayModel[]> {
		let models: GatewayModel[];
		try {
			models = await this.#gatewayModels();
		} catch {
			models = (
				this.#modelCache?.models ??
				supportedChatModels.map((model) => ({
					id: toGatewayModelId(model.provider, model.id),
					provider: model.provider,
					label: model.label,
					contextWindow: model.contextWindow,
					maxOutputTokens: model.maxOutputTokens,
				}))
			).map((model) => ({ ...model }));
		}
		return (provider ? models.filter((model) => model.provider === provider) : models).map(
			(model) => ({ ...model }),
		);
	}

	async getModelLimits(
		config: Pick<LLMConfig, "provider" | "model">,
		signal?: AbortSignal,
	): Promise<ModelLimits> {
		signal?.throwIfAborted();
		const id = toGatewayModelId(config.provider, config.model);
		const cached =
			this.#modelCache && this.#modelCache.expiresAt > Date.now()
				? this.#modelCache.models.find((model) => model.id === id)
				: undefined;
		// The bundled catalog makes known selections work offline without adding
		// discovery latency to every run. New models use their exact Gateway ID.
		const bundled = findSupportedChatModel(id);
		if (!cached && bundled) {
			return { contextWindow: bundled.contextWindow, maxOutputTokens: bundled.maxOutputTokens };
		}
		// Cancelling one run must not cancel discovery shared by other sessions.
		const live =
			cached ?? (await waitForCatalog(this.listModels(), signal)).find((model) => model.id === id);
		const contextWindow =
			live?.contextWindow ?? bundled?.contextWindow ?? FALLBACK_MODEL_LIMITS.contextWindow;
		return {
			contextWindow,
			maxOutputTokens: Math.min(
				live?.maxOutputTokens ?? bundled?.maxOutputTokens ?? FALLBACK_MODEL_LIMITS.maxOutputTokens,
				contextWindow,
			),
		};
	}

	async #gatewayModels(): Promise<GatewayModel[]> {
		if (this.#modelCache && this.#modelCache.expiresAt > Date.now()) return this.#modelCache.models;
		if (this.#modelRequest) return this.#modelRequest;

		this.#modelRequest = (async () => {
			// Catalog discovery is public and never needs a user's inference credentials.
			const response = await fetch(GATEWAY_MODELS_URL, {
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new Error(`Gateway model catalog returned HTTP ${response.status}`);
			const payload = gatewayModelsSchema.parse(await response.json());

			const models = payload.data.flatMap((entry): GatewayModel[] => {
				const parsed = gatewayModelSchema.safeParse(entry);
				if (!parsed.success) return [];
				const model = parsed.data;
				const slash = model.id.indexOf("/");
				const provider = model.id.slice(0, slash);
				const label =
					typeof model.name === "string" && model.name.trim()
						? model.name
						: model.id.slice(slash + 1);
				const contextWindow = tokenLimit(model.context_window);
				const maxOutputTokens = tokenLimit(model.max_tokens);
				return [
					{
						id: model.id,
						provider,
						label,
						contextWindow,
						maxOutputTokens:
							contextWindow && maxOutputTokens && maxOutputTokens > contextWindow
								? undefined
								: maxOutputTokens,
					},
				];
			});
			if (models.length === 0) throw new Error("Gateway model catalog contains no language models");
			this.#modelCache = { expiresAt: Date.now() + MODEL_CACHE_MS, models };
			return models;
		})().finally(() => {
			this.#modelRequest = undefined;
		});
		return this.#modelRequest;
	}
}

export const modelRouter = new ModelRouter();
