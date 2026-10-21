import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { llmConfigSchema } from "@nightcode/shared";
import { ModelRouter } from "./model-router";

afterEach(() => mock.restore());

describe("Gateway model routing", () => {
	it("rejects qualified provider mismatches before contacting the Gateway", () => {
		const router = new ModelRouter();
		expect(() =>
			router.resolve(llmConfigSchema.parse({ provider: "openai", model: "anthropic/new-model" })),
		).toThrow("belongs to anthropic");
	});

	it("reports removed Azure support with migration guidance", () => {
		expect(() =>
			new ModelRouter().resolve(llmConfigSchema.parse({ provider: "azure", model: "deployment" })),
		).toThrow("Direct Azure deployments are no longer supported");
	});

	it("normalizes legacy aliases in both short and qualified model IDs", () => {
		const previous = process.env.AI_GATEWAY_API_KEY;
		process.env.AI_GATEWAY_API_KEY = "test-only";
		try {
			const router = new ModelRouter();
			for (const model of ["gpt-5.6", "openai/gpt-5.6"]) {
				const resolved = router.resolve(llmConfigSchema.parse({ model }));
				if (typeof resolved === "string") throw new Error("Expected a Gateway model object");
				expect(resolved.modelId).toBe("openai/gpt-5.6-sol");
			}
		} finally {
			if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
			else process.env.AI_GATEWAY_API_KEY = previous;
		}
	});

	it("preserves verified GPT-6 selections when qualifying Gateway requests", () => {
		const previous = process.env.AI_GATEWAY_API_KEY;
		process.env.AI_GATEWAY_API_KEY = "test-only";
		try {
			const router = new ModelRouter();
			for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
				for (const selection of [model, `openai/${model}`]) {
					const resolved = router.resolve(llmConfigSchema.parse({ model: selection }));
					if (typeof resolved === "string") throw new Error("Expected a Gateway model object");
					expect(resolved.modelId).toBe(`openai/${model}`);
				}
			}
		} finally {
			if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
			else process.env.AI_GATEWAY_API_KEY = previous;
		}
	});

	it("qualifies current Claude API IDs to the verified Gateway versions", () => {
		const previous = process.env.AI_GATEWAY_API_KEY;
		process.env.AI_GATEWAY_API_KEY = "test-only";
		try {
			const router = new ModelRouter();
			for (const family of ["sonnet", "opus"]) {
				for (const model of [`claude-${family}-5-5`, `anthropic/claude-${family}-5.5`]) {
					const resolved = router.resolve(llmConfigSchema.parse({ provider: "anthropic", model }));
					if (typeof resolved === "string") throw new Error("Expected a Gateway model object");
					expect(resolved.modelId).toBe(`anthropic/claude-${family}-5.5`);
				}
			}
		} finally {
			if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
			else process.env.AI_GATEWAY_API_KEY = previous;
		}
	});
});

describe("Gateway catalog discovery and model limits", () => {
	it("uses bundled limits offline for known short and qualified selections", async () => {
		const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
		const router = new ModelRouter();
		for (const model of ["gpt-6-astra", "openai/gpt-6-astra"]) {
			expect(await router.getModelLimits({ provider: "openai", model })).toEqual({
				contextWindow: 1_050_000,
				maxOutputTokens: 128_000,
			});
		}
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects an already aborted lookup without starting discovery", async () => {
		const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
		const controller = new AbortController();
		controller.abort(new Error("Run cancelled"));
		await expect(
			new ModelRouter().getModelLimits(
				{ provider: "openai", model: "future-model" },
				controller.signal,
			),
		).rejects.toThrow("Run cancelled");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("cancels one waiting run promptly while another receives the shared discovery", async () => {
		const pending = Promise.withResolvers<Response>();
		const fetcher = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
		const controller = new AbortController();
		const router = new ModelRouter();
		const cancelled = router.getModelLimits(
			{ provider: "openai", model: "future-model" },
			controller.signal,
		);
		const remaining = router.getModelLimits({ provider: "openai", model: "future-model" });
		controller.abort(new Error("Run cancelled"));
		await expect(cancelled).rejects.toThrow("Run cancelled");
		expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
		pending.resolve(
			Response.json({
				data: [
					{
						id: "openai/future-model",
						type: "language",
						context_window: 500_000,
						max_tokens: 64_000,
					},
				],
			}),
		);
		expect(await remaining).toEqual({ contextWindow: 500_000, maxOutputTokens: 64_000 });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("retains live limits by exact Gateway ID and coalesces concurrent discovery", async () => {
		const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				data: [
					{
						id: "anthropic/future-model",
						name: "Future Claude",
						type: "language",
						context_window: 1_000_000,
						max_tokens: 128_000,
					},
					{
						id: "openai/future-model",
						type: "language",
						context_window: 400_000,
						max_tokens: 32_000,
					},
				],
			}),
		);
		const router = new ModelRouter();
		const [anthropic, openai, models] = await Promise.all([
			router.getModelLimits({ provider: "anthropic", model: "future-model" }),
			router.getModelLimits({ provider: "openai", model: "openai/future-model" }),
			router.listModels("anthropic"),
		]);
		expect(anthropic).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
		expect(openai).toEqual({ contextWindow: 400_000, maxOutputTokens: 32_000 });
		expect(models).toEqual([
			{
				id: "anthropic/future-model",
				provider: "anthropic",
				label: "Future Claude",
				contextWindow: 1_000_000,
				maxOutputTokens: 128_000,
			},
		]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]?.[0]).toBe("https://ai-gateway.vercel.sh/v1/models");
		expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
		expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
		const listedModel = models[0];
		if (!listedModel) throw new Error("Expected the discovered model");
		listedModel.contextWindow = 1;
		expect(await router.getModelLimits({ provider: "anthropic", model: "future-model" })).toEqual(
			anthropic,
		);
	});

	it("uses refreshed live metadata for bundled models after catalog discovery", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				data: [
					{
						id: "openai/gpt-6-astra",
						type: "language",
						context_window: 2_000_000,
						max_tokens: 256_000,
					},
				],
			}),
		);
		const router = new ModelRouter();
		await router.listModels();
		expect(await router.getModelLimits({ provider: "openai", model: "gpt-6-astra" })).toEqual({
			contextWindow: 2_000_000,
			maxOutputTokens: 256_000,
		});
	});

	it("skips malformed and non-language entries without losing valid language models", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				data: [
					null,
					"model",
					{},
					{ id: "unqualified", type: "language" },
					{ id: "openai/", type: "language" },
					{ id: "openai/has space", type: "language" },
					{ id: "openai/missing-type" },
					{ id: "openai/embedding", type: "embedding" },
					{ id: "openai/future-model", name: 42, type: "language" },
				],
			}),
		);
		expect(await new ModelRouter().listModels()).toEqual([
			{
				id: "openai/future-model",
				provider: "openai",
				label: "future-model",
				contextWindow: undefined,
				maxOutputTokens: undefined,
			},
		]);
	});

	it("rejects invalid token limits and never exceeds a valid context window", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				data: [
					{ id: "openai/invalid", type: "language", context_window: "1000000", max_tokens: -1 },
					{ id: "openai/fraction", type: "language", context_window: 3.5, max_tokens: 1.5 },
					{ id: "openai/zero", type: "language", context_window: 0, max_tokens: 0 },
					{
						id: "openai/unsafe",
						type: "language",
						context_window: Number.MAX_SAFE_INTEGER + 1,
						max_tokens: Number.MAX_SAFE_INTEGER + 1,
					},
					{ id: "openai/over-context", type: "language", context_window: 4_096, max_tokens: 8_192 },
				],
			}),
		);
		const router = new ModelRouter();
		for (const model of ["invalid", "fraction", "zero", "unsafe"]) {
			expect(await router.getModelLimits({ provider: "openai", model })).toEqual({
				contextWindow: 32_768,
				maxOutputTokens: 8_192,
			});
		}
		expect(await router.getModelLimits({ provider: "openai", model: "over-context" })).toEqual({
			contextWindow: 4_096,
			maxOutputTokens: 4_096,
		});
	});

	it("falls back on network, HTTP, JSON and catalog schema failures", async () => {
		const fetcher = spyOn(globalThis, "fetch");
		for (const response of [
			() => Promise.reject(new Error("Offline")),
			async () => new Response("Unavailable", { status: 503 }),
			async () => new Response("{"),
			async () => Response.json(null),
			async () => Response.json({ data: {} }),
			async () => Response.json({ data: [{ id: "openai/image", type: "image" }] }),
		]) {
			fetcher.mockImplementation(Object.assign(response, { preconnect() {} }));
			const router = new ModelRouter();
			expect(await router.getModelLimits({ provider: "openai", model: "future-model" })).toEqual({
				contextWindow: 32_768,
				maxOutputTokens: 8_192,
			});
			expect(
				(await router.listModels("openai")).some((model) => model.id === "openai/gpt-6-astra"),
			).toBe(true);
		}
	});

	it("retains stale discovery data on refresh failure and retries later", async () => {
		let now = 1_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				data: [
					{
						id: "openai/future-model",
						type: "language",
						context_window: 600_000,
						max_tokens: 64_000,
					},
				],
			}),
		);
		const router = new ModelRouter();
		const original = await router.listModels();
		now += 5 * 60 * 1000 + 1;
		fetcher.mockRejectedValueOnce(new Error("Offline"));
		expect(await router.listModels()).toEqual(original);
		fetcher.mockRejectedValueOnce(new Error("Still offline"));
		expect(await router.getModelLimits({ provider: "openai", model: "future-model" })).toEqual({
			contextWindow: 600_000,
			maxOutputTokens: 64_000,
		});
		fetcher.mockResolvedValueOnce(
			Response.json({
				data: [
					{
						id: "openai/future-model",
						type: "language",
						context_window: 800_000,
						max_tokens: 64_000,
					},
				],
			}),
		);
		expect((await router.listModels())[0]?.contextWindow).toBe(800_000);
		expect(fetcher).toHaveBeenCalledTimes(4);
	});
});
