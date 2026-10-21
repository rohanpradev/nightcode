// Explicitly opt-in: real, billable Gateway checks against disposable fixtures.
import "../packages/server/src/lib/env";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	agentRunResultSchema,
	type LLMStreamChunk,
	llmStreamChunkSchema,
} from "../packages/shared/src/schemas";

async function* parseEventStream(response: Response): AsyncGenerator<LLMStreamChunk> {
	if (!response.ok || !response.body) throw new Error(`Stream HTTP ${response.status}`);
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			if (buffer.length > 1_000_000) throw new Error("Live stream exceeded fixture limit");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			if (done && buffer.trim()) lines.push(buffer);
			for (const line of lines) {
				if (!line.trim()) continue;
				const event = llmStreamChunkSchema.parse(JSON.parse(line));
				yield event;
				if (["done", "error", "aborted"].includes(event.type)) return;
			}
			if (done) throw new Error("Stream ended without a terminal event");
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

const root = resolve(import.meta.dir, "..");
const key = process.env.AI_GATEWAY_API_KEY?.trim();
if (!key)
	throw new Error("Set NIGHTCODE_ENV_FILE to the trusted file containing AI_GATEWAY_API_KEY.");
const model = process.env.NIGHTCODE_LIVE_MODEL ?? "openai/gpt-4.1-mini";
if (!["openai/gpt-4.1-nano", "openai/gpt-4.1-mini"].includes(model)) {
	throw new Error("This low-cost suite only accepts GPT-4.1 nano or mini.");
}
const catalogResponse = await fetch("https://ai-gateway.vercel.sh/v1/models", {
	signal: AbortSignal.timeout(15_000),
});
if (!catalogResponse.ok) throw new Error(`Catalog HTTP ${catalogResponse.status}`);
const catalog = (await catalogResponse.json()) as {
	data: Array<{
		id: string;
		pricing?: { input: string; output: string; input_cache_read?: string };
	}>;
};
const pricing = catalog.data.find((entry) => entry.id === model)?.pricing;
if (
	!pricing ||
	!Number.isFinite(Number(pricing.input)) ||
	!Number.isFinite(Number(pricing.output)) ||
	Number(pricing.input) < 0 ||
	Number(pricing.output) < 0 ||
	Number(pricing.input) > 0.0000004 ||
	Number(pricing.output) > 0.0000016
) {
	throw new Error("Model missing or pricing exceeds this suite's low-cost ceiling.");
}

await mkdir(join(root, "tmp"), { recursive: true });
const workspace = await mkdtemp(join(root, "tmp", "gateway-live-"));
const emptyEnv = join(workspace, "empty.env");
await Bun.write(emptyEnv, "");
const token = crypto.randomUUID();
const env: Record<string, string> = {};
for (const name of [
	"PATH",
	"Path",
	"SYSTEMROOT",
	"SystemRoot",
	"WINDIR",
	"TEMP",
	"TMP",
	"HOME",
	"USERPROFILE",
]) {
	if (process.env[name]) env[name] = process.env[name] as string;
}
const server = Bun.spawn(
	[process.execPath, "--no-env-file", "run", "packages/server/src/index.ts"],
	{
		cwd: root,
		env: {
			...env,
			AI_GATEWAY_API_KEY: key,
			NIGHTCODE_ENV_FILE: emptyEnv,
			NIGHTCODE_PROVIDER: "openai",
			NIGHTCODE_MODEL: model,
			PORT: "0",
			NIGHTCODE_HOST: "127.0.0.1",
			NIGHTCODE_API_TOKEN: token,
			NIGHTCODE_LOG_LEVEL: "info",
			NIGHTCODE_SERVER_WORKSPACE_ROOTS: workspace,
			NIGHTCODE_MAX_TOKENS: "768",
			NIGHTCODE_MAX_AGENT_STEPS: "10",
			NIGHTCODE_MAX_RETRIES: "0",
			NIGHTCODE_MAX_RUN_DURATION_MS: "45000",
			NIGHTCODE_CONTEXT_BUDGET: "4000",
			NIGHTCODE_DISABLED_TOOLS:
				"shell,glob,grep,listAgentProfiles,loadAgentProfile,listSkills,loadSkill,listLspServers",
		},
		stdout: "pipe",
		stderr: "pipe",
	},
);
let logs = "";
const collect = async (stream: ReadableStream<Uint8Array>) => {
	const decoder = new TextDecoder();
	for await (const chunk of stream)
		logs = (logs + decoder.decode(chunk, { stream: true })).slice(-32_000);
};
const collected = Promise.all([collect(server.stdout), collect(server.stderr)]);
const timeout = setTimeout(() => server.kill(), 240_000);
const results: Array<{ name: string; passed: boolean; durationMs: number; error?: string }> = [];
const traces: Record<string, unknown> = {};
let inputTokens = 0;
let outputTokens = 0;
let cachedInputTokens = 0;
const addUsage = (usage: Extract<LLMStreamChunk, { type: "done" }>["usage"]) => {
	inputTokens += usage?.inputTokens ?? 0;
	outputTokens += usage?.outputTokens ?? 0;
	cachedInputTokens += usage?.cachedInputTokens ?? 0;
};
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const redact = (value: string) =>
	value.replaceAll(key, "[REDACTED]").replaceAll(token, "[REDACTED]");
async function test(name: string, run: () => Promise<void>) {
	const start = Date.now();
	try {
		await run();
		results.push({ name, passed: true, durationMs: Date.now() - start });
		console.log(`PASS: ${name}`);
	} catch (error) {
		const message = redact(error instanceof Error ? error.message : String(error));
		results.push({ name, passed: false, durationMs: Date.now() - start, error: message });
		console.log(`FAIL: ${name}: ${message}`);
	}
}

try {
	const deadline = Date.now() + 10_000;
	while (!logs.includes("server listening") && Date.now() < deadline && server.exitCode === null)
		await Bun.sleep(20);
	const url = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
	if (!url) throw new Error("Local server failed to start.");
	console.log(`Live model: ${model}; fixtures: ${workspace}`);
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const request = (path: string, body?: unknown, method = body ? "POST" : "GET") =>
		fetch(`${url}${path}`, {
			method,
			headers,
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(55_000),
		});
	const chat = async (name: string, sessionId: string, prompt: string, agentMode = true) => {
		const events = await Array.fromAsync(
			parseEventStream(
				await request("/chat", {
					workspace,
					sessionId,
					messages: [{ role: "user", content: prompt }],
					config: { agentMode },
				}),
			),
		);
		traces[name] = events;
		const terminal = events.at(-1);
		if (terminal?.type === "done") addUsage(terminal.usage);
		check(
			!events.some(
				(event) =>
					event.type === "error" || (event.type === "tool-result" && event.toolResult.isError),
			),
			`Stream failed: ${JSON.stringify(events.filter((event) => event.type === "error" || (event.type === "tool-result" && event.toolResult.isError)))}`,
		);
		return events;
	};
	const completed = (events: LLMStreamChunk[]) => {
		const last = events.at(-1);
		check(
			last?.type === "done" && last.finishReason === "stop",
			`Unexpected terminal event: ${JSON.stringify(last)}`,
		);
	};
	const resolveApproval = async (
		name: string,
		sessionId: string,
		events: LLMStreamChunk[],
		approved: boolean,
	) => {
		const approval = events.find((event) => event.type === "approval-request");
		if (approval?.type !== "approval-request") throw new Error("No approval was requested.");
		const decision = {
			approvalId: approval.approval.id,
			approved,
			reason: "Disposable live-test fixture only",
		};
		const resumed = await Array.fromAsync(
			parseEventStream(await request("/approvals", { sessionId, workspace, decision })),
		);
		traces[name] = resumed;
		const last = resumed.at(-1);
		if (last?.type === "done") addUsage(last.usage);
		completed(resumed);
		return decision;
	};

	await test("HTTP authentication and workspace boundary", async () => {
		check((await fetch(`${url}/health`)).status === 401, "Unauthenticated access was accepted");
		check((await request("/health")).ok, "Authenticated health check failed");
		check(
			(await request("/chat", { workspace: root, messages: [{ role: "user", content: "hello" }] }))
				.status === 403,
			"Outside workspace was accepted",
		);
	});
	await test("Real streaming reply and token usage", async () => {
		const events = await chat(
			"reply",
			"live-reply",
			"Reply with exactly NIGHTCODE_LIVE_OK and no other text.",
			false,
		);
		completed(events);
		check(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.text)
				.join("")
				.trim() === "NIGHTCODE_LIVE_OK",
			"Reply did not match",
		);
		check(inputTokens > 0 && outputTokens > 0, "Missing real token usage");
	});
	await test("Non-stream agent reads, plans, and saves README", async () => {
		const original = "# Nightcode fixture\n\nA Bun application.\n";
		await Bun.write(join(workspace, "README.md"), original);
		await Bun.write(
			join(workspace, "package.json"),
			JSON.stringify({ scripts: { dev: "bun --watch app.ts", test: "bun test" } }),
		);
		const response = await request("/agents/coding/run", {
			workspace,
			sessionId: "live-readme",
			messages: [
				{
					role: "user",
					content:
						"Read README.md and package.json. Create a task plan, then use applyPatch to append a concise '## Local development' section with bun install, bun run dev, and bun test to README.md. Preserve the original text. Do not run shell commands. Save the file and finish with a brief summary.",
				},
			],
		});
		check(response.ok, `HTTP ${response.status}`);
		const result = agentRunResultSchema.parse(await response.json());
		traces.readme = result;
		addUsage(result.usage);
		check(
			result.status === "completed" && result.toolCalls >= 3,
			`Agent did not complete with tools: ${JSON.stringify(result)}`,
		);
		const actual = await Bun.file(join(workspace, "README.md")).text();
		check(
			actual.startsWith(original) &&
				["## Local development", "bun install", "bun run dev", "bun test"].every((text) =>
					actual.includes(text),
				),
			"README content check failed",
		);
	});
	const literalBefore = "\uFEFFprefix TARGET suffix\r\n";
	const replacement = "$$ $& $` $'";
	await test("Literal file edit preserves dollar tokens and BOM", async () => {
		await Bun.write(join(workspace, "literal.txt"), literalBefore);
		completed(
			await chat(
				"literal",
				"live-literal",
				`Create a task plan, then call editFile on literal.txt with oldText ${JSON.stringify("TARGET")} and newText ${JSON.stringify(replacement)}. Do not replace the whole file. Save and finish briefly. No shell commands.`,
			),
		);
		check(
			(await readFile(join(workspace, "literal.txt"), "utf8")) ===
				literalBefore.replace("TARGET", () => replacement),
			"Literal edit content mismatch",
		);
	});
	await test("Undo waits for approval, resumes, and rejects duplicate execution", async () => {
		check(
			results.find((item) => item.name.startsWith("Literal file"))?.passed,
			"Requires successful literal edit",
		);
		const events = await chat(
			"undo-pending",
			"live-literal",
			"Call undoLastPatch exactly once to undo the last edit. Wait if approval is required. After approval, report completion without any other file changes or tool calls.",
		);
		const patched = await readFile(join(workspace, "literal.txt"), "utf8");
		check(patched !== literalBefore, "Undo ran before approval");
		check(
			(await request("/sessions/live-literal", undefined, "DELETE")).status === 409,
			"Pending session was deletable",
		);
		const decision = await resolveApproval("undo-approved", "live-literal", events, true);
		check(
			(await readFile(join(workspace, "literal.txt"), "utf8")) === literalBefore,
			"Undo did not restore original bytes",
		);
		const repeated = await Array.fromAsync(
			parseEventStream(await request("/approvals", { sessionId: "live-literal", decision })),
		);
		traces["duplicate-approval"] = repeated;
		check(
			!repeated.some((event) => event.type === "tool-call" || event.type === "tool-result"),
			"Duplicate decision executed a tool",
		);
		check(
			(await readFile(join(workspace, "literal.txt"), "utf8")) === literalBefore,
			"Duplicate decision changed the file",
		);
	});
	await test("Denied deletion leaves the file intact", async () => {
		await Bun.write(join(workspace, "keep.txt"), "keep this fixture\n");
		const events = await chat(
			"delete-pending",
			"live-denied",
			"Create a task plan then use applyPatch with one delete operation on keep.txt. This requires approval. If denied, accept the denial and stop without attempting any other action. No shell commands.",
		);
		check(await Bun.file(join(workspace, "keep.txt")).exists(), "Deletion ran before approval");
		await resolveApproval("delete-denied", "live-denied", events, false);
		check(
			(await Bun.file(join(workspace, "keep.txt")).text()) === "keep this fixture\n",
			"Denied deletion changed the file",
		);
	});
	await test("Completed sessions can be released", async () => {
		for (const id of ["live-reply", "live-readme", "live-literal", "live-denied"]) {
			check(
				(await request(`/sessions/${id}`, undefined, "DELETE")).ok,
				`Session ${id} not released`,
			);
		}
	});
} catch (error) {
	const message = redact(error instanceof Error ? error.message : String(error));
	results.push({ name: "Live suite infrastructure", passed: false, durationMs: 0, error: message });
	console.log(`FAIL: Live suite infrastructure: ${message}`);
} finally {
	clearTimeout(timeout);
	server.kill();
	await server.exited;
	await collected;
	const estimatedUsd = inputTokens * Number(pricing.input) + outputTokens * Number(pricing.output);
	const report = {
		completedAt: new Date().toISOString(),
		bunVersion: Bun.version,
		budgets: {
			maxAgentSteps: 10,
			maxOutputTokensPerStep: 768,
			maxRetries: 0,
			maxRunDurationMs: 45000,
		},
		model,
		workspace,
		pricing,
		results,
		usage: { inputTokens, outputTokens, cachedInputTokens },
		estimatedUsdBeforeCacheDiscounts: estimatedUsd,
		traces,
	};
	await Bun.write(join(workspace, "report.json"), redact(JSON.stringify(report, null, 2)));
	console.log(
		JSON.stringify(
			{
				passed: results.filter((item) => item.passed).length,
				failed: results.filter((item) => !item.passed).length,
				inputTokens,
				outputTokens,
				estimatedUsdBeforeCacheDiscounts: estimatedUsd,
				report: join(workspace, "report.json"),
			},
			null,
			2,
		),
	);
}
if (results.some((result) => !result.passed)) process.exitCode = 1;
