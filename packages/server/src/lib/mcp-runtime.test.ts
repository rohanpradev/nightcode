import { describe, expect, it } from "bun:test";
import type { MCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { z } from "zod";
import { connectMCPTools } from "./mcp-runtime";

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
});
