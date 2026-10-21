import { describe, expect, it } from "bun:test";
import type { LLMConfig } from "@nightcode/shared";
import { requiresAppendOnlyHistory, resolveModelCallSettings } from "./model-call-settings";

describe("model call settings", () => {
	for (const model of ["gpt-6-astra", "openai/gpt-6-astra", "gpt-6.1-sol"]) {
		it(`normalizes unsupported none reasoning and temperature for ${model}`, () => {
			expect(
				resolveModelCallSettings({
					provider: "openai",
					model,
					reasoningEffort: "none",
					temperature: 0.2,
				}),
			).toEqual({ reasoningEffort: "low", temperature: undefined });
		});
	}

	for (const model of ["gpt-6-sol", "gpt-6-luna"]) {
		for (const reasoningEffort of [undefined, "none", "high"] as const) {
			it(`keeps sampling only for explicit none reasoning on ${model}/${reasoningEffort}`, () => {
				expect(
					resolveModelCallSettings({
						provider: "openai",
						model,
						reasoningEffort,
						temperature: 0.7,
					}),
				).toEqual({ reasoningEffort, temperature: reasoningEffort === "none" ? 0.7 : undefined });
			});
		}
	}

	for (const [provider, model] of [
		["openai", "gpt-5.6"],
		["anthropic", "claude-sonnet-4-6"],
		["anthropic", "other/gpt-6-astra"],
	] satisfies Array<[LLMConfig["provider"], string]>) {
		it(`preserves existing sampling settings for ${provider}/${model}`, () => {
			expect(
				resolveModelCallSettings({ provider, model, reasoningEffort: "high", temperature: 0.4 }),
			).toEqual({ reasoningEffort: "high", temperature: 0.4 });
		});
	}

	for (const model of [
		"claude-sonnet-5-5",
		"anthropic/claude-sonnet-5.5",
		"claude-opus-5-5",
		"anthropic/claude-haiku-5.5",
		"anthropic/claude-fable-5.1",
	]) {
		it(`uses signed-history and sampling compatibility for ${model}`, () => {
			expect(requiresAppendOnlyHistory({ provider: "anthropic", model })).toBe(true);
			expect(
				resolveModelCallSettings({
					provider: "anthropic",
					model,
					reasoningEffort: "max",
					temperature: 0.4,
				}),
			).toEqual({ reasoningEffort: "max", temperature: undefined });
		});
	}

	it("does not apply signed Anthropic history rules to other providers or older models", () => {
		expect(requiresAppendOnlyHistory({ provider: "openai", model: "claude-sonnet-5-5" })).toBe(
			false,
		);
		expect(requiresAppendOnlyHistory({ provider: "anthropic", model: "claude-sonnet-4-6" })).toBe(
			false,
		);
	});
});
