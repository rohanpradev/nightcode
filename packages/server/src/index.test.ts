import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "./index";
import { runtimeManager } from "./services/runtime-manager";

describe("server routes", () => {
	it("rejects a rebinding Host header over a real loopback connection", async () => {
		const previous = process.env.NIGHTCODE_API_TOKEN;
		delete process.env.NIGHTCODE_API_TOKEN;
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
				headers: { Host: "attacker.example", Origin: "http://attacker.example" },
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "HOST_NOT_ALLOWED" });
		} finally {
			await server.stop(true);
			if (previous !== undefined) process.env.NIGHTCODE_API_TOKEN = previous;
		}
	});

	it("rejects unauthenticated DNS rebinding authorities even with a matching origin", async () => {
		const previous = process.env.NIGHTCODE_API_TOKEN;
		delete process.env.NIGHTCODE_API_TOKEN;
		try {
			const response = await app.request("http://attacker.example:3000/health", {
				headers: { Origin: "http://attacker.example:3000", "Sec-Fetch-Site": "same-origin" },
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "HOST_NOT_ALLOWED" });
		} finally {
			if (previous !== undefined) process.env.NIGHTCODE_API_TOKEN = previous;
		}
	});

	it.each(["http://attacker.example", "null", "http://localhost:3001", "https://localhost:3000"])(
		"rejects browser origin %s before any session allocation",
		async (origin) => {
			const before = runtimeManager.list().length;
			const response = await app.request("http://localhost:3000/chat", {
				method: "POST",
				headers: { Origin: origin, "Content-Type": "application/json" },
				body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
			expect(runtimeManager.list()).toHaveLength(before);
		},
	);

	it.each(["cross-site", "same-site"])(
		"rejects %s fetch metadata without an origin",
		async (site) => {
			const response = await app.request("/health", { headers: { "Sec-Fetch-Site": site } });
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
		},
	);

	it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
		"accepts native and same-origin clients at %s",
		async (origin) => {
			expect((await app.request(`${origin}/health`)).status).toBe(200);
			expect(
				(
					await app.request(`${origin}/health`, {
						headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
					})
				).status,
			).toBe(200);
		},
	);

	it("accepts authenticated remote clients while preserving origin validation", async () => {
		const previous = process.env.NIGHTCODE_API_TOKEN;
		process.env.NIGHTCODE_API_TOKEN = "remote-test-token";
		try {
			const headers = { Authorization: "Bearer remote-test-token" };
			expect((await app.request("https://nightcode.example/health", { headers })).status).toBe(200);
			const response = await app.request("https://nightcode.example/health", {
				headers: { ...headers, Origin: "https://attacker.example" },
			});
			expect(response.status).toBe(403);
		} finally {
			if (previous === undefined) delete process.env.NIGHTCODE_API_TOKEN;
			else process.env.NIGHTCODE_API_TOKEN = previous;
		}
	});

	it("accepts contained directories whose names start with two dots", async () => {
		const workspace = await mkdtemp(join(process.cwd(), "..nightcode-test-"));
		const sessionId = crypto.randomUUID();
		try {
			const response = await app.request("/agents/coding/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					workspace,
					sessionId,
					messages: [{ role: "user", content: "cancelled" }],
				}),
				signal: AbortSignal.abort(new Error("caller cancelled")),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ status: "aborted" });
		} finally {
			runtimeManager.delete(sessionId);
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it.each([true, false])(
		"rejects oversized requests before validation (content-length: %s)",
		async (withLength) => {
			const body = " ".repeat(8 * 1024 * 1024 + 1);
			const headers = new Headers({ "Content-Type": "application/json" });
			if (withLength) headers.set("Content-Length", String(body.length));
			const response = await app.request("/chat", { method: "POST", body, headers });
			expect(response.status).toBe(413);
			expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
		},
	);

	it("returns an aborted non-stream outcome with its generated session id", async () => {
		const response = await app.request("/agents/coding/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "cancelled" }] }),
			signal: AbortSignal.abort(new Error("caller cancelled")),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "aborted" });
		const sessionId = response.headers.get("X-Nightcode-Session-Id");
		expect(sessionId).toBeTruthy();
		if (sessionId) runtimeManager.delete(sessionId);
	});

	it("reports health and supports HEAD through the GET handler", async () => {
		const getResponse = await app.request("/health");
		expect(getResponse.status).toBe(200);

		const health = (await getResponse.json()) as {
			ok: boolean;
			provider: string;
			model: string;
		};
		expect(health.ok).toBe(true);
		expect(typeof health.provider).toBe("string");
		expect(typeof health.model).toBe("string");

		const headResponse = await app.request("/health", { method: "HEAD" });
		expect(headResponse.status).toBe(getResponse.status);
		expect(headResponse.body).toBeNull();
	});

	it("returns available providers", async () => {
		const response = await app.request("/providers");
		expect(response.status).toBe(200);

		const providers = (await response.json()) as unknown[];
		expect(Array.isArray(providers)).toBe(true);
		expect(providers.length).toBeGreaterThan(0);
	});

	it("validates model provider query values", async () => {
		const response = await app.request("/models?provider=bogus");
		expect(response.status).toBe(400);
	});

	it("returns resolved model catalog entries", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (..._args: Parameters<typeof fetch>) =>
				Response.json({
					data: [{ id: "openai/gpt-5.6-sol", name: "GPT 5.6", type: "language" }],
				}),
			{ preconnect: originalFetch.preconnect },
		);
		try {
			const response = await app.request("/models?provider=openai");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual([
				{ id: "openai/gpt-5.6-sol", provider: "openai", label: "GPT 5.6" },
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("validates chat request JSON before model execution", async () => {
		const response = await app.request("/chat", {
			method: "POST",
			body: JSON.stringify({ messages: [] }),
			headers: new Headers({ "Content-Type": "application/json" }),
		});

		expect(response.status).toBe(400);
	});

	it("rejects request-selected workspaces outside configured server roots", async () => {
		const outside = await mkdtemp(join(tmpdir(), "nightcode-server-outside-"));
		const response = await app.request("/chat", {
			method: "POST",
			body: JSON.stringify({
				messages: [{ role: "user", content: "hello" }],
				workspace: outside,
			}),
			headers: new Headers({ "Content-Type": "application/json" }),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "WORKSPACE_NOT_ALLOWED" });
	});

	it("pins an API session to its original workspace", async () => {
		const sessionId = crypto.randomUUID();
		runtimeManager.getOrCreate(sessionId, process.cwd());

		const mismatch = await app.request("/chat", {
			method: "POST",
			body: JSON.stringify({
				sessionId,
				workspace: resolve("packages", "server"),
				messages: [{ role: "user", content: "hello" }],
			}),
			headers: new Headers({ "Content-Type": "application/json" }),
		});
		expect(mismatch.status).toBe(409);
		expect(await mismatch.json()).toMatchObject({ code: "SESSION_WORKSPACE_MISMATCH" });
		runtimeManager.delete(sessionId);
	});

	it("does not allocate sessions for unknown approval ids", async () => {
		const sessionId = crypto.randomUUID();
		const before = runtimeManager.list().length;
		const response = await app.request("/approvals", {
			method: "POST",
			body: JSON.stringify({
				sessionId,
				decision: { approvalId: "missing", approved: false },
			}),
			headers: new Headers({ "Content-Type": "application/json" }),
		});
		expect(response.status).toBe(404);
		expect(runtimeManager.list()).toHaveLength(before);
	});

	it("enforces configured bearer authentication", async () => {
		const previous = process.env.NIGHTCODE_API_TOKEN;
		process.env.NIGHTCODE_API_TOKEN = "test-token";
		try {
			const denied = await app.request("/health");
			expect(denied.status).toBe(401);
			expect(denied.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(denied.headers.get("Referrer-Policy")).toBe("no-referrer");
			const allowed = await app.request("/health", {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(allowed.status).toBe(200);
		} finally {
			if (previous === undefined) delete process.env.NIGHTCODE_API_TOKEN;
			else process.env.NIGHTCODE_API_TOKEN = previous;
		}
	});

	it("returns structured state for unknown session approvals", async () => {
		const response = await app.request(`/sessions/${crypto.randomUUID()}/approvals`);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });
	});
});
