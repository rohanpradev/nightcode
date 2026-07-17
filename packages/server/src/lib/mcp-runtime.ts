import { realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { delimiter, resolve } from "node:path";
import { createMCPClient, type MCPClient, type MCPClientConfig } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import type { MCPServerConfig } from "./config-loader";
import { optionalEnv } from "./env";
import { createToolEnvironment } from "./shell-policy";

export interface ConnectedMCPTools {
	tools: ToolSet;
	approvalTools: Set<string>;
	warnings: string[];
	close(): Promise<void>;
}

export interface ConnectMCPOptions {
	createClient?: (config: MCPClientConfig) => Promise<MCPClient>;
	isWorkspaceTrusted?: (workspaceRoot: string) => boolean | Promise<boolean>;
	timeoutMs?: number;
}

const DEFAULT_MCP_TIMEOUT_MS = 15_000;
const DEFAULT_MCP_CLOSE_TIMEOUT_MS = 2_000;

export async function connectMCPTools(
	servers: Record<string, MCPServerConfig> | null,
	workspaceRoot: string,
	disabledTools: ReadonlySet<string>,
	options: ConnectMCPOptions = {},
): Promise<ConnectedMCPTools> {
	const tools: ToolSet = {};
	const approvalTools = new Set<string>();
	const warnings: string[] = [];
	const clients: MCPClient[] = [];
	if (!servers) return { tools, approvalTools, warnings, close: async () => undefined };

	const trusted = await (options.isWorkspaceTrusted ?? isMCPWorkspaceTrusted)(workspaceRoot);
	if (!trusted) {
		warnings.push(
			"Project MCP configuration was not started because this workspace is not trusted. Set NIGHTCODE_TRUSTED_MCP_WORKSPACES to the exact workspace path or NIGHTCODE_ENABLE_PROJECT_MCP=true in trusted user environment configuration.",
		);
		return { tools, approvalTools, warnings, close: async () => undefined };
	}

	const timeoutMs = options.timeoutMs ?? configuredMCPTimeout();

	try {
		for (const [serverName, config] of Object.entries(servers)) {
			if (config.transport === "http") validateMCPHttpUrl(config.url as string);
			const client = await createClientWithTimeout(
				(options.createClient ?? createMCPClient)({
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
				}),
				timeoutMs,
				`connecting to MCP server ${serverName}`,
			);
			clients.push(client);
			const discovered = await withTimeout(
				client.tools(),
				timeoutMs,
				`discovering tools from MCP server ${serverName}`,
			);
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
		await closeClients(clients);
		throw error;
	}

	return {
		tools,
		approvalTools,
		warnings,
		close: async () => {
			await closeClients(clients);
		},
	};
}

export async function isMCPWorkspaceTrusted(workspaceRoot: string): Promise<boolean> {
	if (optionalEnv("NIGHTCODE_ENABLE_PROJECT_MCP") === "true") return true;
	const configured = optionalEnv("NIGHTCODE_TRUSTED_MCP_WORKSPACES");
	if (!configured) return false;

	const canonicalWorkspace = await realpath(resolve(workspaceRoot)).catch(() =>
		resolve(workspaceRoot),
	);
	const normalize = (path: string) => {
		const normalized = resolve(path);
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	};
	for (const path of configured
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean)) {
		const canonical = await realpath(resolve(path)).catch(() => resolve(path));
		if (normalize(canonical) === normalize(canonicalWorkspace)) return true;
	}
	return false;
}

export function validateMCPHttpUrl(value: string): void {
	const url = new URL(value);
	if (url.username || url.password)
		throw new Error("MCP URLs must not contain embedded credentials");
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const literal = parseIpLiteral(host);
	const loopback = host === "localhost" || (literal ? isLoopbackAddress(literal) : false);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("Remote MCP servers require HTTPS; HTTP is allowed only for loopback");
	}
	if (!loopback && isPrivateOrMetadataHost(host, literal)) {
		throw new Error(`MCP URL targets a private, link-local, or metadata host: ${host}`);
	}
}

interface IpLiteral {
	version: 4 | 6;
	bytes: number[];
}

function isPrivateOrMetadataHost(host: string, literal = parseIpLiteral(host)): boolean {
	if (
		host === "metadata.google.internal" ||
		host.endsWith(".internal") ||
		host.endsWith(".local")
	) {
		return true;
	}
	if (!literal) return false;
	if (literal.version === 4) return isBlockedIPv4(literal.bytes);

	const bytes = literal.bytes;
	if (isIPv4MappedIPv6(bytes)) {
		// Mapped loopback addresses are deliberately not treated as HTTP loopback. They are
		// rejected here when their embedded IPv4 target is not safe for remote access.
		return isBlockedIPv4(bytes.slice(12));
	}
	const unspecified = bytes.every((byte) => byte === 0);
	const first = bytes[0] ?? 0;
	const second = bytes[1] ?? 0;
	const uniqueLocal = (first & 0xfe) === 0xfc;
	const linkLocal = first === 0xfe && (second & 0xc0) === 0x80;
	return unspecified || uniqueLocal || linkLocal;
}

function isLoopbackAddress(literal: IpLiteral): boolean {
	if (literal.version === 4) return literal.bytes[0] === 127;
	if (isIPv4MappedIPv6(literal.bytes)) return false;
	return literal.bytes.slice(0, 15).every((byte) => byte === 0) && literal.bytes[15] === 1;
}

function isBlockedIPv4(bytes: number[]): boolean {
	if (bytes.length !== 4) return true;
	const [first = -1, second = -1, third = -1, fourth = -1] = bytes;
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		// Well-known cloud metadata service addresses outside RFC 1918 ranges.
		(first === 168 && second === 63 && third === 129 && fourth === 16) ||
		(first === 100 && second === 100 && third === 100 && fourth === 200)
	);
}

function isIPv4MappedIPv6(bytes: number[]): boolean {
	return (
		bytes.length === 16 &&
		bytes.slice(0, 10).every((byte) => byte === 0) &&
		bytes[10] === 0xff &&
		bytes[11] === 0xff
	);
}

function parseIpLiteral(host: string): IpLiteral | null {
	const version = isIP(host);
	if (version === 4) {
		const bytes = host.split(".").map(Number);
		return bytes.length === 4 &&
			bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
			? { version, bytes }
			: null;
	}
	if (version !== 6) return null;

	const halves = host.split("::");
	if (halves.length > 2) return null;
	const left = parseIPv6Groups(halves[0] ?? "");
	const right = halves.length === 2 ? parseIPv6Groups(halves[1] ?? "") : [];
	if (!left || !right) return null;
	const omitted = 8 - left.length - right.length;
	if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
	const groups = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
	if (groups.length !== 8) return null;
	return {
		version,
		bytes: groups.flatMap((group) => [group >>> 8, group & 0xff]),
	};
}

function parseIPv6Groups(value: string): number[] | null {
	if (!value) return [];
	const segments = value.split(":");
	const groups: number[] = [];
	for (const [index, segment] of segments.entries()) {
		if (segment.includes(".")) {
			if (index !== segments.length - 1 || isIP(segment) !== 4) return null;
			const [first = 0, second = 0, third = 0, fourth = 0] = segment.split(".").map(Number);
			groups.push((first << 8) | second, (third << 8) | fourth);
			continue;
		}
		if (!/^[\da-f]{1,4}$/i.test(segment)) return null;
		groups.push(Number.parseInt(segment, 16));
	}
	return groups;
}

function configuredMCPTimeout(): number {
	const value = Number(optionalEnv("NIGHTCODE_MCP_TIMEOUT_MS") ?? DEFAULT_MCP_TIMEOUT_MS);
	return Number.isFinite(value) && value >= 1_000
		? Math.min(value, 120_000)
		: DEFAULT_MCP_TIMEOUT_MS;
}

async function closeClients(clients: MCPClient[]): Promise<void> {
	await Promise.allSettled(clients.map((client) => closeClient(client)));
}

async function closeClient(client: MCPClient): Promise<void> {
	// Defer invocation so a synchronous close() throw is captured by Promise.allSettled
	// and cannot prevent cleanup of the other connected clients.
	await withTimeout(
		Promise.resolve().then(() => client.close()),
		DEFAULT_MCP_CLOSE_TIMEOUT_MS,
		"closing MCP client",
	);
}

async function createClientWithTimeout(
	promise: Promise<MCPClient>,
	timeoutMs: number,
	operation: string,
): Promise<MCPClient> {
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutError = new Error(`${operation} timed out after ${timeoutMs}ms`);
	const guarded = promise.then(async (client) => {
		if (!timedOut) return client;
		// The connection completed after Promise.race rejected. It was never registered in
		// the caller's client list, so close it here to avoid an orphaned stdio subprocess.
		await closeClients([client]);
		throw timeoutError;
	});
	try {
		return await Promise.race([
			guarded,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					reject(timeoutError);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	operation: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
}
