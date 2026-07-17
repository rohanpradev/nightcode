import { timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import {
	agentRunResultSchema,
	approvalRequestSchema,
	chatRequestSchema,
	type LLMStreamChunk,
} from "@nightcode/shared";
import { serve } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { optionalEnv } from "./lib/env";
import { CodingAgentService } from "./services/agents";
import { llm } from "./services/llm";
import { logger } from "./services/logger";
import { modelRouter } from "./services/model-router";
import { RuntimeSessionError, runtimeManager } from "./services/runtime-manager";

const app = new Hono()
	.use("*", async (c, next) => {
		const expectedToken = optionalEnv("NIGHTCODE_API_TOKEN");
		if (expectedToken && !hasValidBearerToken(c.req.header("Authorization"), expectedToken)) {
			return c.json(
				{ error: "A valid Nightcode bearer token is required", code: "UNAUTHORIZED" },
				401,
				{ "WWW-Authenticate": 'Bearer realm="nightcode"' },
			);
		}
		await next();
		c.header("Referrer-Policy", "no-referrer");
		c.header("X-Content-Type-Options", "nosniff");
		return;
	})
	.get("/health", (c) =>
		c.json({
			ok: true,
			provider: llm.config.provider,
			model: llm.config.model,
			activeSessions: runtimeManager.list().length,
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
		const sessionId = body.sessionId ?? crypto.randomUUID();
		try {
			const service = await getOrCreateRequestRuntime(sessionId, body.workspace);
			return ndjsonResponse(
				(signal) => service.stream(body.messages, body.config, { sessionId, abortSignal: signal }),
				c.req.raw.signal,
				{ "X-Nightcode-Session-Id": sessionId },
			);
		} catch (error) {
			return runtimeErrorResponse(c, error);
		}
	})
	.post("/approvals", zValidator("json", approvalRequestSchema), async (c) => {
		const body = c.req.valid("json");
		try {
			const existing = runtimeManager.get(body.sessionId);
			if (!existing) {
				return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
			}
			const service = body.workspace
				? runtimeManager.getOrCreate(body.sessionId, await authorizeServerWorkspace(body.workspace))
				: existing;
			return ndjsonResponse(
				(signal) =>
					service.resolveApproval(body.decision, {
						sessionId: body.sessionId,
						abortSignal: signal,
					}),
				c.req.raw.signal,
				{ "X-Nightcode-Session-Id": body.sessionId },
			);
		} catch (error) {
			return runtimeErrorResponse(c, error);
		}
	})
	.get("/sessions/:sessionId/approvals", (c) => {
		const sessionId = c.req.param("sessionId");
		const service = runtimeManager.get(sessionId);
		if (!service) return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
		return c.json({ sessionId, approvals: service.getPendingApprovals() });
	})
	.delete("/sessions/:sessionId", (c) => {
		const sessionId = c.req.param("sessionId");
		const service = runtimeManager.get(sessionId);
		if (!service) return c.json({ deleted: false, code: "SESSION_NOT_FOUND" }, 404);
		if (service.isBusy || service.getPendingApprovals().length > 0) {
			return c.json(
				{
					deleted: false,
					code: "SESSION_ACTIVE",
					error: "Active or approval-pending sessions cannot be deleted",
				},
				409,
			);
		}
		return c.json({ deleted: runtimeManager.delete(sessionId) }, 200);
	})
	.post("/agents/coding/run", zValidator("json", chatRequestSchema), async (c) => {
		const body = c.req.valid("json");
		const sessionId = body.sessionId ?? crypto.randomUUID();
		try {
			const service = await getOrCreateRequestRuntime(sessionId, body.workspace);
			const result = await new CodingAgentService(service).run({
				...body,
				sessionId,
				abortSignal: c.req.raw.signal,
			});
			return c.json(agentRunResultSchema.parse(result));
		} catch (error) {
			return runtimeErrorResponse(c, error);
		}
	});

function ndjsonResponse(
	createStream: (signal: AbortSignal) => AsyncGenerator<LLMStreamChunk>,
	requestSignal: AbortSignal,
	headers: Record<string, string> = {},
): Response {
	const abortController = new AbortController();
	const onRequestAbort = () => abortController.abort(requestSignal.reason ?? "request aborted");
	if (requestSignal.aborted) onRequestAbort();
	else requestSignal.addEventListener("abort", onRequestAbort, { once: true });
	const encoder = new TextEncoder();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of createStream(abortController.signal)) {
					if (cancelled) break;
					controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
				}
			} catch (error) {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({ type: "error", error: message, code: "STREAM_FAILED" })}\n`,
						),
					);
				}
			} finally {
				requestSignal.removeEventListener("abort", onRequestAbort);
				if (!cancelled) controller.close();
			}
		},
		cancel(reason) {
			cancelled = true;
			abortController.abort(reason ?? "response consumer cancelled");
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			"X-Content-Type-Options": "nosniff",
			...headers,
		},
	});
}

async function getOrCreateRequestRuntime(sessionId: string, requestedWorkspace?: string) {
	const existing = runtimeManager.get(sessionId);
	if (existing && !requestedWorkspace) return existing;
	const workspace = await authorizeServerWorkspace(requestedWorkspace);
	return runtimeManager.getOrCreate(sessionId, workspace);
}

async function authorizeServerWorkspace(requested?: string): Promise<string> {
	const candidate = await realpath(resolve(requested ?? process.cwd()));
	if (!(await stat(candidate)).isDirectory()) throw new Error(`Not a directory: ${candidate}`);

	const configuredRoots = (process.env.NIGHTCODE_SERVER_WORKSPACE_ROOTS?.trim() || process.cwd())
		.split(delimiter)
		.map((path) => path.trim())
		.filter(Boolean);
	const roots = await Promise.all(configuredRoots.map((path) => realpath(resolve(path))));
	if (!roots.some((root) => containsPath(root, candidate))) {
		throw new RuntimeSessionError(
			"WORKSPACE_NOT_ALLOWED",
			`Workspace is outside NIGHTCODE_SERVER_WORKSPACE_ROOTS: ${candidate}`,
		);
	}
	return candidate;
}

function containsPath(root: string, candidate: string): boolean {
	const normalize = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
	const path = relative(normalize(root), normalize(candidate));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function hasValidBearerToken(header: string | undefined, expectedToken: string): boolean {
	if (!header?.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
	const expected = Buffer.from(expectedToken, "utf8");
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function runtimeErrorResponse(
	c: { json: (body: unknown, status: 400 | 403 | 409 | 500) => Response },
	error: unknown,
) {
	if (error instanceof RuntimeSessionError) {
		const status = error.code === "WORKSPACE_NOT_ALLOWED" ? 403 : 409;
		return c.json({ error: error.message, code: error.code }, status);
	}
	const message = error instanceof Error ? error.message : String(error);
	logger.error("runtime request failed", { error: message });
	return c.json({ error: message, code: "RUNTIME_FAILED" }, 500);
}

export type AppType = typeof app;

if (import.meta.main) {
	const port = Number(process.env.PORT ?? process.env.NIGHTCODE_PORT ?? 3000);
	const hostname = optionalEnv("NIGHTCODE_HOST") ?? "127.0.0.1";
	if (!isLoopbackHost(hostname) && !optionalEnv("NIGHTCODE_API_TOKEN")) {
		throw new Error(
			"NIGHTCODE_API_TOKEN is required when NIGHTCODE_HOST is not a loopback address",
		);
	}
	const server = serve({
		hostname,
		port,
		maxRequestBodySize: 8 * 1024 * 1024,
		fetch(request, bunServer) {
			const pathname = new URL(request.url).pathname;
			if (
				request.method === "POST" &&
				["/chat", "/approvals", "/agents/coding/run"].includes(pathname)
			) {
				bunServer.timeout(request, 0);
			}
			return app.fetch(request);
		},
	});
	const shutdown = () => {
		logger.info("server shutdown requested");
		void server.stop(false);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	logger.info(`server listening on http://${hostname}:${port}`);
}

function isLoopbackHost(hostname: string): boolean {
	return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

export default app;
