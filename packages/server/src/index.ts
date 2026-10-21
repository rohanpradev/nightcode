import { timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { agentRunResultSchema, approvalRequestSchema, chatRequestSchema } from "@nightcode/shared";
import { serve } from "bun";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { optionalEnv } from "./lib/env";
import { ndjsonResponse } from "./lib/event-stream";
import { CodingAgentService } from "./services/agents";
import { llm } from "./services/llm";
import { logger } from "./services/logger";
import { modelRouter } from "./services/model-router";
import { RuntimeSessionError, runtimeManager } from "./services/runtime-manager";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

const app = new Hono()
	.use("*", async (c, next) => {
		c.header("Referrer-Policy", "no-referrer");
		c.header("X-Content-Type-Options", "nosniff");
		const expectedToken = optionalEnv("NIGHTCODE_API_TOKEN");
		if (expectedToken && !hasValidBearerToken(c.req.header("Authorization"), expectedToken)) {
			return c.json(
				{ error: "A valid Nightcode bearer token is required", code: "UNAUTHORIZED" },
				401,
				{ "WWW-Authenticate": 'Bearer realm="nightcode"' },
			);
		}
		const requestUrl = new URL(c.req.url);
		// Without authentication, only explicit loopback authorities may reach the
		// service. Comparing Origin to an unchecked Host alone permits DNS rebinding.
		if (!expectedToken && !isLoopbackHost(requestUrl.hostname)) {
			return c.json(
				{ error: "A loopback request host is required", code: "HOST_NOT_ALLOWED" },
				403,
			);
		}
		const origin = c.req.header("Origin");
		const fetchSite = c.req.header("Sec-Fetch-Site");
		if (
			(origin !== undefined && origin !== requestUrl.origin) ||
			(fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none")
		) {
			return c.json(
				{ error: "Cross-origin requests are not allowed", code: "ORIGIN_NOT_ALLOWED" },
				403,
			);
		}
		await next();
		return;
	})
	.use(
		"*",
		bodyLimit({
			maxSize: MAX_REQUEST_BYTES,
			onError: (c) =>
				c.json({ error: "Request body exceeds 8 MiB", code: "PAYLOAD_TOO_LARGE" }, 413),
		}),
	)
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
		async (c) => c.json(await modelRouter.listModels(c.req.valid("query").provider)),
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
			c.header("X-Nightcode-Session-Id", sessionId);
			return c.json(agentRunResultSchema.parse(result));
		} catch (error) {
			return runtimeErrorResponse(c, error);
		}
	});

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
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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
		maxRequestBodySize: MAX_REQUEST_BYTES,
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
	logger.info(`server listening on ${server.url.origin}`);
}

function isLoopbackHost(hostname: string): boolean {
	return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

// A default export with a fetch method makes Bun start another HTTP server.
// Keep startup under import.meta.main so imports never bind a port.
export { app };
