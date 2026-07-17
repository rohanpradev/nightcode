import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import app from "./index";
import { runtimeManager } from "./services/runtime-manager";

describe("server routes", () => {
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
