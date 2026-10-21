import type { LLMConfig } from "@nightcode/shared";

type ModelConfig = Pick<LLMConfig, "provider" | "model">;

function modelIdentity(config: ModelConfig) {
	const slash = config.model.indexOf("/");
	return {
		provider: slash < 0 ? config.provider : config.model.slice(0, slash),
		model: slash < 0 ? config.model : config.model.slice(slash + 1),
	};
}

/** These models sign reasoning blocks against the complete preceding conversation. */
export function requiresAppendOnlyHistory(config: ModelConfig): boolean {
	const { provider, model } = modelIdentity(config);
	return (
		provider === "anthropic" &&
		/^claude-(?:(?:sonnet|opus|haiku)-5[.-]5|fable-5[.-]1)(?:-|$)/.test(model)
	);
}

/** GPT-6 parameter compatibility from the current OpenAI migration guide. */
export function resolveModelCallSettings(
	config: Pick<LLMConfig, "provider" | "model" | "temperature" | "reasoningEffort">,
) {
	const { provider, model } = modelIdentity(config);
	const gpt6 =
		(provider === "openai" || provider === "azure") &&
		/^(gpt-6-astra|gpt-6\.1-sol|gpt-6-sol|gpt-6-luna)(?:-|$)/.test(model);
	const requiresReasoning = /^(gpt-6-astra|gpt-6\.1-sol)(?:-|$)/.test(model);
	const reasoningEffort =
		gpt6 && config.reasoningEffort === "none" && requiresReasoning ? "low" : config.reasoningEffort;
	return {
		reasoningEffort,
		// An omitted effort uses the reasoning-enabled provider default.
		temperature:
			(gpt6 && reasoningEffort !== "none") || requiresAppendOnlyHistory(config)
				? undefined
				: config.temperature,
	};
}
