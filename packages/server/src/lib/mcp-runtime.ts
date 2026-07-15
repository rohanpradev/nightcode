import { createMCPClient, type MCPClient, type MCPClientConfig } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import type { MCPServerConfig } from "./config-loader";
import { createToolEnvironment } from "./shell-policy";

export interface ConnectedMCPTools {
	tools: ToolSet;
	approvalTools: Set<string>;
	close(): Promise<void>;
}

export interface ConnectMCPOptions {
	createClient?: (config: MCPClientConfig) => Promise<MCPClient>;
}

export async function connectMCPTools(
	servers: Record<string, MCPServerConfig> | null,
	workspaceRoot: string,
	disabledTools: ReadonlySet<string>,
	options: ConnectMCPOptions = {},
): Promise<ConnectedMCPTools> {
	const tools: ToolSet = {};
	const approvalTools = new Set<string>();
	const clients: MCPClient[] = [];
	if (!servers) return { tools, approvalTools, close: async () => undefined };

	try {
		for (const [serverName, config] of Object.entries(servers)) {
			const client = await (options.createClient ?? createMCPClient)({
				transport:
					config.transport === "stdio"
						? new Experimental_StdioMCPTransport({
								command: config.command as string,
								args: config.args,
								cwd: workspaceRoot,
								env: { ...(await createToolEnvironment(workspaceRoot)), ...(config.env ?? {}) },
								stderr: "pipe",
							})
						: {
								type: "http",
								url: config.url as string,
								headers: config.headers,
								redirect: "error",
							},
				clientName: "nightcode",
				version: "1.0.0",
				maxRetries: 1,
			});
			clients.push(client);
			const discovered = await client.tools();
			for (const [toolName, mcpTool] of Object.entries(discovered)) {
				if (config.allowedTools && !config.allowedTools.includes(toolName)) continue;
				const namespacedName = `mcp_${safeName(serverName)}_${safeName(toolName)}`;
				if (disabledTools.has(namespacedName) || disabledTools.has(toolName)) continue;
				if (tools[namespacedName]) throw new Error(`Duplicate MCP tool name: ${namespacedName}`);
				Object.assign(tools, { [namespacedName]: mcpTool });
				if (config.requireApproval ?? true) approvalTools.add(namespacedName);
			}
		}
	} catch (error) {
		await Promise.allSettled(clients.map((client) => client.close()));
		throw error;
	}

	return {
		tools,
		approvalTools,
		close: async () => {
			await Promise.allSettled(clients.map((client) => client.close()));
		},
	};
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
}
