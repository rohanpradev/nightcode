import { describe, expect, it } from "bun:test";
import {
	findSupportedChatModel,
	getDefaultModelForProvider,
	getProviderForModel,
	supportedChatModels,
} from "./models";

describe("Gateway model identifiers", () => {
	it("uses the verified flagship for new OpenAI configurations and preserves legacy choices", () => {
		expect(getDefaultModelForProvider("openai")).toBe("gpt-6-astra");
		expect(getDefaultModelForProvider("anthropic")).toBe("claude-sonnet-5-5");
		expect(findSupportedChatModel("gpt-5.6-sol")?.id).toBe("gpt-5.6-sol");
		expect(
			supportedChatModels.filter(
				(model) => model.provider === "openai" && model.defaultForProvider,
			),
		).toHaveLength(1);
		expect(
			supportedChatModels.filter(
				(model) => model.provider === "anthropic" && model.defaultForProvider,
			),
		).toHaveLength(1);
	});

	it("retains GPT-6 context and pricing metadata for qualified Gateway model IDs", () => {
		for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
			const metadata = findSupportedChatModel(`openai/${model}`);
			expect(metadata).toEqual(findSupportedChatModel(model));
			expect(metadata?.contextWindow).toBe(1_050_000);
			expect(metadata?.maxOutputTokens).toBe(128_000);
			expect(getProviderForModel(model)).toBe("openai");
		}
		expect(findSupportedChatModel("openai/gpt-6.1-sol")?.pricing).toEqual({
			inputUsdPerMillionTokens: 2,
			cachedInputUsdPerMillionTokens: 0.1,
			outputUsdPerMillionTokens: 10,
		});
		expect(findSupportedChatModel("anthropic/gpt-6-astra")).toBeUndefined();
	});

	it("retains verified current Claude limits and pricing for both API and Gateway IDs", () => {
		for (const family of ["sonnet", "opus"]) {
			const metadata = findSupportedChatModel(`anthropic/claude-${family}-5.5`);
			expect(metadata).toEqual(findSupportedChatModel(`claude-${family}-5-5`));
			expect(metadata?.contextWindow).toBe(1_000_000);
			expect(metadata?.maxOutputTokens).toBe(128_000);
			expect(getProviderForModel(`claude-${family}-5-5`)).toBe("anthropic");
		}
		expect(findSupportedChatModel("claude-sonnet-5-5")?.pricing).toEqual({
			inputUsdPerMillionTokens: 2,
			cachedInputUsdPerMillionTokens: 0.1,
			outputUsdPerMillionTokens: 10,
		});
		expect(findSupportedChatModel("claude-opus-5-5")?.pricing).toEqual({
			inputUsdPerMillionTokens: 4,
			cachedInputUsdPerMillionTokens: 0.2,
			outputUsdPerMillionTokens: 20,
		});
		expect(findSupportedChatModel("openai/claude-sonnet-5.5")).toBeUndefined();
	});

	it("keeps legacy Claude selections with the verified current Gateway limits", () => {
		for (const model of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]) {
			expect(findSupportedChatModel(model)?.contextWindow).toBe(1_000_000);
			expect(findSupportedChatModel(model)?.maxOutputTokens).toBe(128_000);
		}
		expect(findSupportedChatModel("claude-sonnet-4-5")?.maxOutputTokens).toBe(64_000);
		expect(findSupportedChatModel("claude-haiku-4-5")?.maxOutputTokens).toBe(64_000);
	});

	it("preserves metadata for provider-qualified model selections", () => {
		expect(findSupportedChatModel("openai/gpt-5.6-sol")).toEqual(
			findSupportedChatModel("gpt-5.6-sol"),
		);
		expect(findSupportedChatModel("anthropic/claude-sonnet-4.6")).toEqual(
			findSupportedChatModel("claude-sonnet-4-6"),
		);
		expect(findSupportedChatModel("anthropic/gpt-5.6-sol")).toBeUndefined();
	});

	it("infers providers for new catalog models without borrowing another provider's metadata", () => {
		expect(getProviderForModel("anthropic/new-model")).toBe("anthropic");
		expect(getProviderForModel("openai/new-model")).toBe("openai");
		expect(getProviderForModel("unknown/gpt-5.6-sol")).toBeUndefined();
		expect(findSupportedChatModel("unknown/gpt-5.6-sol")).toBeUndefined();
	});
});
