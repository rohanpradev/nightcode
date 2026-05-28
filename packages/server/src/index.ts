import { zValidator } from "@hono/zod-validator";
import { serve } from "bun";
import { Hono } from "hono";
import "./lib/env";
import { agentRunResultSchema, chatRequestSchema } from "@nightcode/shared";
import { z } from "zod";
import { codingAgent } from "./services/agents";
import { llm } from "./services/llm";
import { logger } from "./services/logger";
import { modelRouter } from "./services/model-router";

const app = new Hono()
	.get("/health", (c) =>
		c.json({
			ok: true,
			provider: llm.config.provider,
			model: llm.config.model,
		}),
	)
	.get("/providers", (c) => c.json(modelRouter.getAvailableProviders()))
	.get(
		"/models",
		zValidator(
			"query",
			z.object({
				provider: z.enum(["openai", "anthropic", "azure"]).optional(),
			}),
		),
		(c) => c.json(modelRouter.listModels(c.req.valid("query").provider)),
	)
	.post("/chat", zValidator("json", chatRequestSchema), async (c) => {
		const body = c.req.valid("json");

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				try {
					for await (const chunk of llm.stream(body.messages, body.config)) {
						controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
					}
					controller.close();
				} catch (error) {
					controller.error(error);
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "application/x-ndjson; charset=utf-8",
				"Cache-Control": "no-cache",
			},
		});
	})
	.post("/agents/coding/run", zValidator("json", chatRequestSchema), async (c) => {
		const body = c.req.valid("json");
		const result = await codingAgent.run(body);
		return c.json(agentRunResultSchema.parse(result));
	});

export type AppType = typeof app;

if (import.meta.main) {
	const port = Number(process.env.PORT ?? process.env.NIGHTCODE_PORT ?? 3000);
	serve({
		port,
		fetch: app.fetch,
	});
	logger.info(`server listening on http://localhost:${port}`);
}

export default app;
