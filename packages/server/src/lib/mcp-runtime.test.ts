import { describe, expect, it } from "bun:test";
import type { MCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { z } from "zod";
import { connectMCPTools, validateMCPHttpUrl } from "./mcp-runtime";

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
