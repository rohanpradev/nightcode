import { describe, expect, it } from "bun:test";
import app from "./index";

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
});
