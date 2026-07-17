import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { assessShellCommand } from "../lib/shell-policy";
import {
	createLLMService,
	decideToolApproval,
	type ToolApprovalPolicyInput,
} from "./agent-runtime";

type MockStreamPart =
	Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
		? Part
		: never;

function stream(parts: MockStreamPart[]): ReadableStream<MockStreamPart> {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}

describe("NightcodeLLMService", () => {
	it("rejects concurrent runs in the same session", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-busy-"));
		const service = createLLMService({
			workspaceRoot: workspace,
			model: new MockLanguageModelV4(),
		});
		const first = service.stream([{ role: "user", content: "first" }], { agentMode: false });
		expect((await first.next()).value).toMatchObject({ type: "run-start" });
		expect(service.isBusy).toBe(true);

		const second = service.stream([{ role: "user", content: "second" }], { agentMode: false });
		expect((await second.next()).value).toMatchObject({
			type: "error",
			code: "RUN_IN_PROGRESS",
		});
		await first.return(undefined);
		expect(service.isBusy).toBe(false);
	});

	it("keeps presentation notices and caller system messages out of model input", async () => {
		const model = new MockLanguageModelV4({
			doStream: {
				stream: stream([
					{ type: "stream-start", warnings: [] },
					{ type: "text-start", id: "answer" },
					{ type: "text-delta", id: "answer", delta: "hello" },
					{ type: "text-end", id: "answer" },
					{
						type: "finish",
						finishReason: { unified: "stop", raw: "stop" },
						usage: {
							inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
							outputTokens: { total: 1, text: 1, reasoning: 0 },
						},
					},
				]),
			},
		});
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-"));
		const service = createLLMService({ workspaceRoot: workspace, model });
		service.configure({ systemPrompt: "TRUSTED-SERVICE-INSTRUCTIONS" });
		const chunks = [];
		for await (const chunk of service.stream(
			[
				{ role: "system", content: "CALLER-SYSTEM-POISON" },
				{ role: "notice", content: "UI-NOTICE-POISON" },
				{ role: "user", content: "hello" },
			],
			{ agentMode: false, systemPrompt: "CALLER-CONFIG-POISON" },
			{ sessionId: "session-test" },
		)) {
			chunks.push(chunk);
		}

		expect(chunks[0]).toMatchObject({ type: "run-start", version: 1, sessionId: "session-test" });
		expect(chunks.some((chunk) => chunk.type === "text" && chunk.text === "hello")).toBe(true);
		expect(chunks.at(-1)?.type).toBe("done");
		expect(chunks.map((chunk) => chunk.sequence)).toEqual(chunks.map((_, index) => index));
		const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
		expect(prompt).toContain("hello");
		expect(prompt).toContain("TRUSTED-SERVICE-INSTRUCTIONS");
		expect(prompt).not.toContain("CALLER-SYSTEM-POISON");
		expect(prompt).not.toContain("UI-NOTICE-POISON");
		expect(prompt).not.toContain("CALLER-CONFIG-POISON");
	});

	it("resumes a concurrently resolved approval at most once", async () => {
		const usage = {
			inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 1, text: 1, reasoning: 0 },
		};
		const model = new MockLanguageModelV4({
			doStream: [
				{
					stream: stream([
						{ type: "stream-start", warnings: [] },
						{
							type: "tool-call",
							toolCallId: "undo-1",
							toolName: "undoLastPatch",
							input: "{}",
						},
						{
							type: "finish",
							finishReason: { unified: "tool-calls", raw: "tool_calls" },
							usage,
						},
					]),
				},
				{
					stream: stream([
						{ type: "stream-start", warnings: [] },
						{ type: "text-start", id: "answer" },
						{ type: "text-delta", id: "answer", delta: "continued" },
						{ type: "text-end", id: "answer" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage,
						},
					]),
				},
			],
		});
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-approval-"));
		const service = createLLMService({ workspaceRoot: workspace, model });
		const initial = [];
		for await (const chunk of service.stream([{ role: "user", content: "undo the last change" }], {
			agentMode: true,
			approvalMode: "on-risk",
		})) {
			initial.push(chunk);
		}
		const request = initial.find((chunk) => chunk.type === "approval-request");
		expect(request?.type).toBe("approval-request");
		if (request?.type !== "approval-request") throw new Error("approval missing");

		const decision = { approvalId: request.approval.id, approved: true };
		const left = service.resolveApproval(decision);
		const right = service.resolveApproval(decision);
		const [leftHead, rightHead] = await Promise.all([left.next(), right.next()]);
		const drain = async (
			generator: AsyncGenerator<unknown>,
			head: IteratorResult<unknown>,
		): Promise<unknown[]> => {
			const chunks: unknown[] = [];
			let current = head;
			while (!current.done) {
				chunks.push(current.value);
				current = await generator.next();
			}
			return chunks;
		};
		const [leftChunks, rightChunks] = await Promise.all([
			drain(left, leftHead),
			drain(right, rightHead),
		]);
		const resolutionChunks = [...leftChunks, ...rightChunks] as Array<{ type?: string }>;

		expect(model.doStreamCalls).toHaveLength(2);
		expect(resolutionChunks.filter((chunk) => chunk.type === "run-start")).toHaveLength(1);
		expect(service.isBusy).toBe(false);
	});

	it("serializes parallel writes into reversible checkpoints", async () => {
		const usage = {
			inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 1, text: 1, reasoning: 0 },
		};
		const model = new MockLanguageModelV4({
			doStream: [
				{
					stream: stream([
						{ type: "stream-start", warnings: [] },
						{
							type: "tool-call",
							toolCallId: "plan-1",
							toolName: "updateTaskPlan",
							input: JSON.stringify({
								summary: "write safely",
								items: [{ id: "write", title: "write file", status: "in_progress" }],
								verification: [],
							}),
						},
						{
							type: "finish",
							finishReason: { unified: "tool-calls", raw: "tool_calls" },
							usage,
						},
					]),
				},
				{
					stream: stream([
						{ type: "stream-start", warnings: [] },
						{
							type: "tool-call",
							toolCallId: "write-1",
							toolName: "writeFile",
							input: JSON.stringify({ path: "shared.txt", content: "first" }),
						},
						{
							type: "tool-call",
							toolCallId: "write-2",
							toolName: "writeFile",
							input: JSON.stringify({ path: "shared.txt", content: "second" }),
						},
						{
							type: "finish",
							finishReason: { unified: "tool-calls", raw: "tool_calls" },
							usage,
						},
					]),
				},
				{
					stream: stream([
						{ type: "stream-start", warnings: [] },
						{ type: "text-start", id: "answer" },
						{ type: "text-delta", id: "answer", delta: "done" },
						{ type: "text-end", id: "answer" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage,
						},
					]),
				},
			],
		});
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-mutations-"));
		const service = createLLMService({ workspaceRoot: workspace, model });

		for await (const _chunk of service.stream([{ role: "user", content: "write twice" }], {
			agentMode: true,
			approvalMode: "on-risk",
		})) {
			// Drain the complete agent run.
		}

		const target = join(workspace, "shared.txt");
		expect(await readFile(target, "utf8")).toBe("second");
		expect(await service.undoLastPatch()).toContain("restored 1 file");
		expect(await readFile(target, "utf8")).toBe("first");
		expect(await service.undoLastPatch()).toContain("restored 1 file");
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("requires approval before reading a conventional secret file", async () => {
		const usage = {
			inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 1, text: 1, reasoning: 0 },
		};
		const model = new MockLanguageModelV4({
			doStream: {
				stream: stream([
					{ type: "stream-start", warnings: [] },
					{
						type: "tool-call",
						toolCallId: "read-secret",
						toolName: "readFile",
						input: JSON.stringify({ path: ".env" }),
					},
					{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
				]),
			},
		});
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-secret-"));
		await writeFile(join(workspace, ".env"), "TOKEN=do-not-read");
		const service = createLLMService({ workspaceRoot: workspace, model });
		const chunks = [];
		for await (const chunk of service.stream([{ role: "user", content: "read .env" }], {
			agentMode: true,
			approvalMode: "never",
		})) {
			chunks.push(chunk);
		}

		const request = chunks.find((chunk) => chunk.type === "approval-request");
		expect(request).toMatchObject({
			type: "approval-request",
			approval: { toolName: "readFile", reason: "Read sensitive file: .env" },
		});
	});

	it("enforces repository PLAN mode and ignores an untrusted project model", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-plan-"));
		await mkdir(join(workspace, ".nightcode"));
		await writeFile(
			join(workspace, ".nightcode", "config.yaml"),
			"mode: PLAN\nmodel: attacker-controlled-model\n",
		);
		await writeFile(join(workspace, ".nightcode", "instructions.md"), "x".repeat(255_000));
		const model = new MockLanguageModelV4({
			doStream: {
				stream: stream([
					{ type: "stream-start", warnings: [] },
					{
						type: "finish",
						finishReason: { unified: "stop", raw: "stop" },
						usage: {
							inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
							outputTokens: { total: 0, text: 0, reasoning: 0 },
						},
					},
				]),
			},
		});
		const service = createLLMService({ workspaceRoot: workspace, model });

		expect(service.config.model).not.toBe("attacker-controlled-model");
		expect(service.config.systemPrompt).toContain("PLAN mode is active");
		expect(service.config.systemPrompt).toContain("model=attacker-controlled-model was ignored");
		expect(service.config.systemPrompt?.length).toBeLessThanOrEqual(240_000);
		const trustedMaxTokens = service.config.maxTokens;
		service.configure({ maxTokens: 128_000, approvalMode: "never" });
		expect(service.config.maxTokens).toBe(trustedMaxTokens);
		expect(service.config.approvalMode).not.toBe("never");

		for await (const _chunk of service.stream([{ role: "user", content: "inspect only" }], {
			agentMode: true,
		})) {
			// Drain the run so the mock captures the advertised tool catalog.
		}
		const advertisedTools = JSON.stringify(model.doStreamCalls[0]?.tools);
		expect(advertisedTools).not.toContain("writeFile");
		expect(advertisedTools).not.toContain("applyPatch");
		expect(advertisedTools).not.toContain("undoLastPatch");
	});
});

describe("decideToolApproval", () => {
	const cases: Array<{
		name: string;
		input: ToolApprovalPolicyInput;
		expected: "approved" | "user-approval" | "denied";
	}> = [
		{
			name: "always prompts even an MCP tool not otherwise marked risky",
			input: { kind: "mcp", approvalMode: "always", requiresApproval: false },
			expected: "user-approval",
		},
		{
			name: "never denies an MCP tool that requires approval",
			input: { kind: "mcp", approvalMode: "never", requiresApproval: true },
			expected: "denied",
		},
		{
			name: "never permits an MCP tool not marked risky",
			input: { kind: "mcp", approvalMode: "never", requiresApproval: false },
			expected: "approved",
		},
		{
			name: "on-risk prompts for an MCP tool that requires approval",
			input: { kind: "mcp", approvalMode: "on-risk", requiresApproval: true },
			expected: "user-approval",
		},
		{
			name: "never denies delete mutations",
			input: {
				kind: "mutation",
				approvalMode: "never",
				deletes: true,
				external: false,
				undo: false,
			},
			expected: "denied",
		},
		{
			name: "never denies external mutations",
			input: {
				kind: "mutation",
				approvalMode: "never",
				deletes: false,
				external: true,
				undo: false,
			},
			expected: "denied",
		},
		{
			name: "never denies undo",
			input: {
				kind: "mutation",
				approvalMode: "never",
				deletes: false,
				external: false,
				undo: true,
			},
			expected: "denied",
		},
		{
			name: "never permits ordinary in-workspace writes",
			input: {
				kind: "mutation",
				approvalMode: "never",
				deletes: false,
				external: false,
				undo: false,
			},
			expected: "approved",
		},
		{
			name: "on-risk prompts for risky mutations",
			input: {
				kind: "mutation",
				approvalMode: "on-risk",
				deletes: true,
				external: false,
				undo: false,
			},
			expected: "user-approval",
		},
		{
			name: "always prompts for ordinary mutations",
			input: {
				kind: "mutation",
				approvalMode: "always",
				deletes: false,
				external: false,
				undo: false,
			},
			expected: "user-approval",
		},
		{
			name: "never denies high-risk shell commands",
			input: {
				kind: "shell",
				approvalMode: "never",
				assessment: assessShellCommand("rm target.txt", "never"),
			},
			expected: "denied",
		},
		{
			name: "on-risk prompts for medium-risk shell commands",
			input: {
				kind: "shell",
				approvalMode: "on-risk",
				assessment: assessShellCommand("bun test", "on-risk"),
			},
			expected: "user-approval",
		},
		{
			name: "on-risk permits low-risk shell inspection",
			input: {
				kind: "shell",
				approvalMode: "on-risk",
				assessment: assessShellCommand("git status", "on-risk"),
			},
			expected: "approved",
		},
		{
			name: "always prompts for low-risk shell inspection",
			input: {
				kind: "shell",
				approvalMode: "always",
				assessment: assessShellCommand("git status", "always"),
			},
			expected: "user-approval",
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(decideToolApproval(testCase.input).type).toBe(testCase.expected);
		});
	}
});
