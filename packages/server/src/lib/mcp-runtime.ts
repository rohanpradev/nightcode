import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { realpath } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { delimiter, resolve } from "node:path";
import { createMCPClient, type MCPClient, type MCPClientConfig } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import { fetch as bunFetch } from "bun";
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
									// The transport does not consume stderr; an unread pipe can block the child.
									stderr: "ignore",
								})
							: {
									type: "http",
									url: config.url as string,
									headers: config.headers,
									redirect: "error",
									fetch: createMCPHttpFetch(config.url as string),
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

const blockedAddresses = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	blockedAddresses.addSubnet(address, prefix);
}
blockedAddresses.addAddress("168.63.129.16"); // Azure metadata / virtual platform address.
for (const [address, prefix] of [
	["::", 96],
	["64:ff9b::", 96], // NAT64 can translate directly to private IPv4 destinations.
	["64:ff9b:1::", 48],
	["100::", 64],
	["100:0:0:1::", 64],
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
	["5f00::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const) {
	blockedAddresses.addSubnet(address, prefix, "ipv6");
}

function mcpHostname(url: URL): string {
	return url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
}

function isLoopbackAddress(host: string): boolean {
	// URL already normalizes unusual IPv4 literal encodings. Mapped IPv6 loopback
	// remains blocked, matching the HTTP policy for explicitly configured loopback.
	return (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";
}

function isBlockedAddress(address: string): boolean {
	const version = isIP(address);
	return version === 0 || blockedAddresses.check(address, version === 4 ? "ipv4" : "ipv6");
}

export function validateMCPHttpUrl(value: string): void {
	const url = new URL(value);
	if (url.username || url.password)
		throw new Error("MCP URLs must not contain embedded credentials");
	const host = mcpHostname(url);
	const loopback = host === "localhost" || isLoopbackAddress(host);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("Remote MCP servers require HTTPS; HTTP is allowed only for loopback");
	}
	if (
		!loopback &&
		(host.endsWith(".internal") ||
			host.endsWith(".local") ||
			(isIP(host) !== 0 && isBlockedAddress(host)))
	) {
		throw new Error(`MCP URL targets a private, link-local, or metadata host: ${host}`);
	}
}

type ResolveMCPHost = (hostname: string) => Promise<LookupAddress[]>;

/** Resolve once per request and dial the validated address directly to prevent DNS rebinding. */
export function createMCPHttpFetch(
	endpoint: string,
	resolveHost: ResolveMCPHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
) {
	validateMCPHttpUrl(endpoint);
	const origin = new URL(endpoint).origin;
	const secureFetch = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(input instanceof URL ? input.href : input, init);
		const url = new URL(request.url);
		validateMCPHttpUrl(url.href);
		if (url.origin !== origin) throw new Error("MCP requests must stay on the configured origin");
		request.signal.throwIfAborted();
		const host = mcpHostname(url);
		const family = isIP(host);
		const addresses = family
			? [{ address: host, family }]
			: await resolveMCPHost(host, resolveHost, request.signal);
		const allowLoopback = host === "localhost" || isLoopbackAddress(host);
		if (
			addresses.length === 0 ||
			addresses.some(({ address }) =>
				allowLoopback ? !isLoopbackAddress(address) : isBlockedAddress(address),
			)
		) {
			throw new Error(
				`MCP hostname resolves to a private, reserved, or non-loopback address: ${host}`,
			);
		}
		const target = addresses[0];
		if (!target) throw new Error(`MCP hostname has no addresses: ${host}`);
		request.signal.throwIfAborted();
		const headers = new Headers(request.headers);
		headers.set("host", url.host);
		headers.delete("content-length");
		headers.delete("transfer-encoding");
		const pinnedUrl = new URL(url);
		pinnedUrl.hostname = target.family === 6 ? `[${target.address}]` : target.address;
		// Bun's native fetch keeps streaming, decompression, and cancellation intact.
		// Explicit TLS identity and a direct connection preserve the checked DNS result.
		const response = await bunFetch(pinnedUrl, {
			method: request.method,
			headers,
			body: request.body,
			signal: request.signal,
			redirect: "manual",
			proxy: false,
			...(url.protocol === "https:" ? { tls: { serverName: host, rejectUnauthorized: true } } : {}),
		});
		if (response.status >= 300 && response.status < 400 && response.status !== 304) {
			await response.body?.cancel();
			throw new Error("MCP HTTP redirects are disabled");
		}
		return response;
	};
	// Eager connections would bypass the per-request URL and DNS checks.
	return Object.assign(secureFetch, { preconnect: () => undefined });
}

function resolveMCPHost(
	hostname: string,
	resolveHost: ResolveMCPHost,
	signal: AbortSignal,
): Promise<LookupAddress[]> {
	return new Promise((resolveAddresses, reject) => {
		signal.throwIfAborted();
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		// OS DNS lookup cannot be cancelled, but an aborted request need not wait
		// for it and a late resolution can never start an outgoing connection.
		Promise.resolve()
			.then(() => resolveHost(hostname))
			.then(
				(addresses) => {
					signal.removeEventListener("abort", abort);
					resolveAddresses(addresses);
				},
				(error) => {
					signal.removeEventListener("abort", abort);
					reject(error);
				},
			);
	});
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
