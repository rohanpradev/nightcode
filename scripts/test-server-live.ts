// Opt-in integration check: makes a real, potentially billable Gateway request.
import "../packages/server/src/lib/env";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentRunResultSchema } from "../packages/shared/src/schemas";

const root = resolve(import.meta.dir, "..");
if (!process.env.AI_GATEWAY_API_KEY?.trim() && !process.env.VERCEL_OIDC_TOKEN?.trim()) {
	throw new Error(
		"Configure AI_GATEWAY_API_KEY in ~/.nightcode/.env or set NIGHTCODE_ENV_FILE to your trusted config file before running this live test.",
	);
}

await mkdir(join(root, "tmp"), { recursive: true });
const workspace = await mkdtemp(join(root, "tmp", "server-live-"));
const readmePath = join(workspace, "README.md");
const original = "# Nightcode development sandbox\n\nA Bun-based local coding assistant.\n";
await Bun.write(readmePath, original);
await Bun.write(
	join(workspace, "package.json"),
	JSON.stringify({
		name: "nightcode-live-test-fixture",
		private: true,
		scripts: { dev: "bun --watch run server.ts", test: "bun test" },
	}),
);

const token = crypto.randomUUID();
const server = Bun.spawn([process.execPath, "run", "packages/server/src/index.ts"], {
	cwd: root,
	env: {
		...process.env,
		PORT: "0",
		NIGHTCODE_HOST: "127.0.0.1",
		NIGHTCODE_API_TOKEN: token,
		NIGHTCODE_LOG_LEVEL: "info",
		NIGHTCODE_SERVER_WORKSPACE_ROOTS: workspace,
		NIGHTCODE_MAX_RUN_DURATION_MS: "120000",
		NIGHTCODE_MAX_RETRIES: "0",
	},
	stdout: "pipe",
	stderr: "pipe",
});
let output = "";
async function collect(stream: ReadableStream<Uint8Array>) {
	const decoder = new TextDecoder();
	for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
	output += decoder.decode();
}
const collected = Promise.all([collect(server.stdout), collect(server.stderr)]);
const timeout = setTimeout(() => server.kill(), 150_000);

try {
	const deadline = Date.now() + 10_000;
	while (!output.includes("server listening") && Date.now() < deadline) {
		if (server.exitCode !== null) break;
		await Bun.sleep(20);
	}
	const url = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
	if (!url) throw new Error("Local server did not start within 10 seconds.");
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const health = await fetch(`${url}/health`, { headers, signal: AbortSignal.timeout(5000) });
	if (!health.ok) throw new Error(`Health check failed: HTTP ${health.status}`);
	console.log("Local API ready:", await health.json());
	console.log("Asking the configured AI model to improve README.md in", workspace);
	const response = await fetch(`${url}/agents/coding/run`, {
		method: "POST",
		headers,
		signal: AbortSignal.timeout(130_000),
		body: JSON.stringify({
			workspace,
			messages: [
				{
					role: "user",
					content:
						"Improve README.md in this sandbox. Read README.md and package.json, create a task plan, then edit only README.md to add a concise '## Local development' section explaining bun install, bun run dev, and bun test. Preserve the existing title and introduction. Do not execute commands or contact other services. Use the file-edit tools to save the improvement, then briefly summarize it.",
				},
			],
		}),
	});
	if (!response.ok) throw new Error(`Agent endpoint failed: HTTP ${response.status}`);
	const result = agentRunResultSchema.parse(await response.json());
	console.log(JSON.stringify(result, null, 2));
	if (result.status !== "completed") throw new Error(`Live agent run ended: ${result.status}`);
	if (result.toolCalls === 0 || (result.usage?.totalTokens ?? 0) === 0) {
		throw new Error("Expected real model usage and tool calls.");
	}
	if (result.approvalsRequired !== 0) {
		throw new Error("Ordinary fixture edits should not require user approval.");
	}
	const sessionId = response.headers.get("X-Nightcode-Session-Id");
	if (!sessionId) throw new Error("The agent endpoint did not return its session id.");
	const deletion = await fetch(`${url}/sessions/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
		headers,
		signal: AbortSignal.timeout(5000),
	});
	if (!deletion.ok) throw new Error("The completed session is still active or awaiting approval.");
	const updated = await Bun.file(readmePath).text();
	if (
		updated === original ||
		!updated.startsWith("# Nightcode development sandbox") ||
		!updated.includes("A Bun-based local coding assistant.") ||
		!["## Local development", "bun install", "bun run dev", "bun test"].every((text) =>
			updated.includes(text),
		)
	) {
		throw new Error("The agent did not save the requested README improvement.");
	}
	console.log(`PASS: real HTTP → Gateway → tools → README edit. Result: ${readmePath}`);
} finally {
	clearTimeout(timeout);
	server.kill();
	await server.exited;
	await collected;
}
