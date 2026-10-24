import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { MCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { z } from "zod";
import { connectMCPTools, createMCPHttpFetch, validateMCPHttpUrl } from "./mcp-runtime";

// Public test-only localhost certificate and key, never used outside the loopback fixture.
const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBkzCCATmgAwIBAgIUfdafTI8G/30RXMcOdCiwSWx66JEwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyMDA0MTU0MloXDTQ2MTAxNTA0
MTU0MlowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE1h6uQwVP+sn1hYcsMyUjj5lToiPd5ZOZJcc8sfTDyHSKn7+Z2I5yPMbc
1K8OEk23cFMn9Ltpa6bM5RyeqfAO4aNpMGcwHQYDVR0OBBYEFEk/iLPnG1Z5sZh9
O/QKj5vgUHIeMB8GA1UdIwQYMBaAFEk/iLPnG1Z5sZh9O/QKj5vgUHIeMA8GA1Ud
EwEB/wQFMAMBAf8wFAYDVR0RBA0wC4IJbG9jYWxob3N0MAoGCCqGSM49BAMCA0gA
MEUCIEVytyMyA/lbjjG10fZ7GlxDRelr0bgHHdiLWK5TMYCzAiEAiV7UE4nta+al
91kT2sw+E/WXUlo+mZ5zgF057M7wsQY=
-----END CERTIFICATE-----`;
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgOjOKU4NeVhvwM7Ng
248MzBT6Yx96BE/ulxqkTW9NcdmhRANCAATWHq5DBU/6yfWFhywzJSOPmVOiI93l
k5klxzyx9MPIdIqfv5nYjnI8xtzUrw4STbdwUyf0u2lrpszlHJ6p8A7h
-----END PRIVATE KEY-----`;

describe("MCP runtime adapter", () => {
	it("namespaces, filters, approval-gates, and closes discovered tools", async () => {
		let clientsClosed = 0;
		let connection = 0;
		const connected = await connectMCPTools(
			{
				"local-tools": {
					transport: "http",
					url: "https://example.test/mcp-a",
					allowedTools: ["allowed"],
					requireApproval: false,
				},
				remote: {
					transport: "http",
					url: "https://example.test/mcp-b",
					requireApproval: true,
				},
			},
			process.cwd(),
			new Set(["mcp_remote_disabled"]),
			{
				isWorkspaceTrusted: () => true,
				createClient: async () => {
					connection++;
					const tools =
						connection === 1
							? {
									allowed: tool({ inputSchema: z.object({}), execute: async () => "ok" }),
									hidden: tool({ inputSchema: z.object({}), execute: async () => "hidden" }),
								}
							: {
									approved: tool({ inputSchema: z.object({}), execute: async () => "ok" }),
									disabled: tool({ inputSchema: z.object({}), execute: async () => "disabled" }),
								};
					return {
						tools: async () => tools,
						close: async () => {
							clientsClosed++;
						},
					} as unknown as MCPClient;
				},
			},
		);

		expect(Object.keys(connected.tools).sort()).toEqual([
			"mcp_local_tools_allowed",
			"mcp_remote_approved",
		]);
		expect(connected.approvalTools).toEqual(new Set(["mcp_remote_approved"]));
		await connected.close();
		expect(clientsClosed).toBe(2);
	});

	it("does not connect project MCP servers before explicit workspace trust", async () => {
		let connections = 0;
		const connected = await connectMCPTools(
			{ local: { transport: "stdio", command: "untrusted-command" } },
			process.cwd(),
			new Set(),
			{
				isWorkspaceTrusted: () => false,
				createClient: async () => {
					connections++;
					throw new Error("must not connect");
				},
			},
		);

		expect(connections).toBe(0);
		expect(connected.tools).toEqual({});
		expect(connected.warnings[0]).toContain("not trusted");
	});

	it("requires HTTPS except on loopback and rejects obvious SSRF targets", () => {
		expect(() => validateMCPHttpUrl("https://mcp.example.com/tools")).not.toThrow();
		expect(() => validateMCPHttpUrl("http://127.0.0.1:3001/mcp")).not.toThrow();
		expect(() => validateMCPHttpUrl("http://127.1:3001/mcp")).not.toThrow();
		expect(() => validateMCPHttpUrl("http://[::1]:3001/mcp")).not.toThrow();
		expect(() => validateMCPHttpUrl("http://mcp.example.com/tools")).toThrow("require HTTPS");
		expect(() => validateMCPHttpUrl("https://169.254.169.254/latest/meta-data")).toThrow(
			"private, link-local, or metadata",
		);
		expect(() => validateMCPHttpUrl("https://[::ffff:127.0.0.1]/mcp")).toThrow(
			"private, link-local, or metadata",
		);
		expect(() => validateMCPHttpUrl("https://[::ffff:10.0.0.1]/mcp")).toThrow(
			"private, link-local, or metadata",
		);
		expect(() => validateMCPHttpUrl("https://[::ffff:169.254.169.254]/mcp")).toThrow(
			"private, link-local, or metadata",
		);
		expect(() => validateMCPHttpUrl("https://[fe80::1]/mcp")).toThrow(
			"private, link-local, or metadata",
		);
		expect(() => validateMCPHttpUrl("https://[febf:ffff::1]/mcp")).toThrow(
			"private, link-local, or metadata",
		);
		expect(() => validateMCPHttpUrl("https://[::ffff:8.8.8.8]/mcp")).not.toThrow();
	});

	it("rejects reserved address ranges and normalized internal hostnames", () => {
		for (const target of [
			"100.64.0.1",
			"100.127.255.254",
			"192.0.0.2",
			"198.18.0.1",
			"224.0.0.1",
			"240.0.0.1",
			"255.255.255.255",
			"[ff02::1]",
			"[64:ff9b::a00:1]",
			"[2002:a00:1::]",
			"[fec0::1]",
			"[::ffff:100.64.0.1]",
			"metadata.google.internal.",
			"192.88.99.1",
			"[100:0:0:1::1]",
			"[3fff::1]",
			"[5f00::1]",
		]) {
			expect(() => validateMCPHttpUrl(`https://${target}/mcp`)).toThrow();
		}
		expect(() => validateMCPHttpUrl("https://[2606:4700:4700::1111]/mcp")).not.toThrow();
	});

	it("rejects hostnames resolving to private addresses, including mixed DNS responses", async () => {
		for (const addresses of [
			[{ address: "169.254.169.254", family: 4 }],
			[
				{ address: "8.8.8.8", family: 4 },
				{ address: "10.0.0.1", family: 4 },
			],
			[{ address: "::ffff:192.168.1.1", family: 6 }],
			[],
		]) {
			const secureFetch = createMCPHttpFetch("https://mcp.example.test/mcp", async () => addresses);
			await expect(secureFetch("https://mcp.example.test/mcp")).rejects.toThrow("resolves to");
		}
		const secureFetch = createMCPHttpFetch("https://mcp.example.test/mcp");
		await expect(secureFetch("https://other.example.test/mcp")).rejects.toThrow(
			"configured origin",
		);
	});

	it("pins DNS once per request while preserving Host, authorization, body, and compressed responses", async () => {
		let lookups = 0;
		let receivedBody = "";
		let receivedHost = "";
		let receivedAuthorization = "";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				receivedBody = await request.text();
				receivedHost = request.headers.get("host") ?? "";
				receivedAuthorization = request.headers.get("authorization") ?? "";
				return new Response(gzipSync('{"result":"ok"}'), {
					headers: { "content-encoding": "gzip", "content-type": "application/json" },
				});
			},
		});
		try {
			const endpoint = `http://localhost:${server.port}/mcp`;
			const secureFetch = createMCPHttpFetch(endpoint, async () => {
				lookups++;
				return [{ address: lookups === 1 ? "127.0.0.1" : "10.0.0.1", family: 4 }];
			});
			const response = await secureFetch(endpoint, {
				method: "POST",
				headers: { authorization: "Bearer test-token", "content-length": "9999" },
				body: "tool-call",
			});
			expect(await response.json()).toEqual({ result: "ok" });
			expect(lookups).toBe(1);
			expect(receivedBody).toBe("tool-call");
			expect(receivedHost).toBe(`localhost:${server.port}`);
			expect(receivedAuthorization).toBe("Bearer test-token");
			expect(response.headers.get("content-type")).toBe("application/json");
			await expect(secureFetch(endpoint)).rejects.toThrow("resolves to");
		} finally {
			await server.stop(true);
		}
	});

	it("cancels a request while DNS is still pending", async () => {
		let resolveLookup:
			((addresses: Array<{ address: string; family: number }>) => void) | undefined;
		const controller = new AbortController();
		const reason = new Error("cancelled during DNS");
		const secureFetch = createMCPHttpFetch(
			"https://mcp.example.test/mcp",
			() =>
				new Promise((resolve) => {
					resolveLookup = resolve;
				}),
		);
		const request = secureFetch("https://mcp.example.test/mcp", { signal: controller.signal });
		await Promise.resolve();
		controller.abort(reason);
		await expect(request).rejects.toBe(reason);
		// A late answer cannot turn the cancelled request into an outgoing fetch.
		resolveLookup?.([{ address: "8.8.8.8", family: 4 }]);
	});

	it("rejects an already aborted request before resolving DNS", async () => {
		let lookups = 0;
		const secureFetch = createMCPHttpFetch("https://mcp.example.test/mcp", async () => {
			lookups++;
			return [{ address: "8.8.8.8", family: 4 }];
		});
		const reason = new Error("cancelled before start");
		await expect(
			secureFetch("https://mcp.example.test/mcp", {
				signal: AbortSignal.abort(reason),
			}),
		).rejects.toBe(reason);
		expect(lookups).toBe(0);
	});

	it("does not follow redirects and supports empty responses and streaming cancellation", async () => {
		let redirected = false;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/redirect")
					return new Response(null, { status: 302, headers: { location: "/target" } });
				if (path === "/target") redirected = true;
				if (path === "/empty") return new Response(null, { status: 204 });
				if (path === "/cached") return new Response(null, { status: 304 });
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("data: first\n\n"));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const endpoint = `http://127.0.0.1:${server.port}`;
			const secureFetch = createMCPHttpFetch(endpoint);
			await expect(secureFetch(`${endpoint}/redirect`)).rejects.toThrow("redirects are disabled");
			expect(redirected).toBe(false);
			for (const [path, status] of [
				["empty", 204],
				["cached", 304],
			] as const) {
				const response = await secureFetch(`${endpoint}/${path}`);
				expect(response.status).toBe(status);
				expect(response.body).toBeNull();
			}
			const controller = new AbortController();
			const response = await secureFetch(`${endpoint}/stream`, { signal: controller.signal });
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing stream response");
			const chunk = await reader.read();
			expect(new TextDecoder().decode(chunk.value)).toContain("data: first");
			controller.abort();
			await expect(reader.read()).rejects.toThrow();
		} finally {
			await server.stop(true);
		}
	});

	it("verifies TLS against the original hostname while dialing its pinned IP", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-mcp-tls-"));
		const certificatePath = join(root, "localhost.pem");
		await writeFile(certificatePath, TEST_CERTIFICATE);
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY },
			fetch: (request) => Response.json({ host: request.headers.get("host") }),
		});
		try {
			const endpoint = `https://localhost:${server.port}/mcp`;
			// A fresh process loads this fixture CA without changing global trust or
			// relaxing certificate checks in this test runner or the MCP adapter.
			const source = `
				import { createMCPHttpFetch } from ${JSON.stringify(import.meta.resolve("./mcp-runtime"))};
				const endpoint = ${JSON.stringify(endpoint)};
				const request = createMCPHttpFetch(endpoint, async () => [{address: "127.0.0.1", family: 4}]);
				const response = await request(endpoint);
				const result = await response.json();
				let rejectedWrongHost = false;
				try {
					const wrongHost = endpoint.replace("localhost", "127.0.0.1");
					await createMCPHttpFetch(wrongHost)(wrongHost);
				} catch { rejectedWrongHost = true; }
				console.log(JSON.stringify({ ...result, rejectedWrongHost }));
			`;
			const processResult = Bun.spawn([process.execPath, "--eval", source], {
				cwd: process.cwd(),
				env: {
					...process.env,
					NODE_EXTRA_CA_CERTS: certificatePath,
					NODE_TLS_REJECT_UNAUTHORIZED: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				processResult.exited,
				new Response(processResult.stdout).text(),
				new Response(processResult.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout)).toEqual({
				host: `localhost:${server.port}`,
				rejectedWrongHost: true,
			});
		} finally {
			await server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("closes a client that resolves after its connection timeout", async () => {
		let resolveClient: ((client: MCPClient) => void) | undefined;
		let closes = 0;
		const clientPromise = new Promise<MCPClient>((resolve) => {
			resolveClient = resolve;
		});
		const connection = connectMCPTools(
			{ local: { transport: "stdio", command: "late-command" } },
			process.cwd(),
			new Set(),
			{
				isWorkspaceTrusted: () => true,
				createClient: () => clientPromise,
				timeoutMs: 5,
			},
		);

		await expect(connection).rejects.toThrow("timed out");
		resolveClient?.({
			tools: async () => ({}),
			close: async () => {
				closes++;
			},
		} as unknown as MCPClient);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(closes).toBe(1);
	});

	it("closes an established client when tool discovery times out", async () => {
		let closes = 0;
		const connection = connectMCPTools(
			{ local: { transport: "stdio", command: "slow-discovery" } },
			process.cwd(),
			new Set(),
			{
				isWorkspaceTrusted: () => true,
				createClient: async () =>
					({
						tools: () => new Promise(() => undefined),
						close: async () => {
							closes++;
						},
					}) as unknown as MCPClient,
				timeoutMs: 5,
			},
		);

		await expect(connection).rejects.toThrow("discovering tools");
		expect(closes).toBe(1);
	});

	it("continues closing remaining clients when one close throws synchronously", async () => {
		let connection = 0;
		let successfulCloses = 0;
		const connected = await connectMCPTools(
			{
				first: { transport: "http", url: "https://example.test/first" },
				second: { transport: "http", url: "https://example.test/second" },
			},
			process.cwd(),
			new Set(),
			{
				isWorkspaceTrusted: () => true,
				createClient: async () => {
					connection++;
					const current = connection;
					return {
						tools: async () => ({}),
						close: () => {
							if (current === 1) throw new Error("close failed");
							successfulCloses++;
							return Promise.resolve();
						},
					} as unknown as MCPClient;
				},
			},
		);

		await connected.close();
		expect(successfulCloses).toBe(1);
	});
});
