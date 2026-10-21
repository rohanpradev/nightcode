import { describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import * as mcpRuntime from "../lib/mcp-runtime";
import { workspaceMutationCoordinator } from "../lib/mutation-coordinator";
import { assessShellCommand } from "../lib/shell-policy";
import {
	createLLMService,
	decideToolApproval,
	type ToolApprovalPolicyInput,
} from "./agent-runtime";
import { modelRouter } from "./model-router";

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

function response(toolName?: string, input: unknown = {}, reasoning = false) {
	return {
		stream: stream([
			{ type: "stream-start", warnings: [] },
			...(reasoning
				? [
						{
							type: "reasoning-start" as const,
							id: "thought",
							providerMetadata: { anthropic: { signature: "signed-prefix" } },
						},
						{ type: "reasoning-delta" as const, id: "thought", delta: "" },
						{
							type: "reasoning-end" as const,
							id: "thought",
							providerMetadata: { anthropic: { signature: "signed-prefix" } },
						},
					]
				: []),
			...(toolName
				? [
						{
							type: "tool-call" as const,
							toolCallId: toolName,
							toolName,
							input: JSON.stringify(input),
						},
					]
				: []),
			{
				type: "finish",
				finishReason: {
					unified: toolName ? "tool-calls" : "stop",
					raw: toolName ? "tool_calls" : "stop",
				},
				usage: {
					inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
			},
		]),
	};
}

describe("NightcodeLLMService", () => {
	for (const limited of [false, true]) {
		it(`reports ${limited ? "step-limit after tool calls" : "natural success at the step limit"}`, async () => {
			const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-limit-"));
			await mkdir(join(workspace, ".nightcode"));
			await writeFile(join(workspace, ".nightcode", "config.yaml"), "maxAgentSteps: 2\n");
			const model = new MockLanguageModelV4({
				doStream: [
					response("getTaskPlan"),
					limited ? response("listFiles", { path: "." }) : response(),
				],
			});
			const service = createLLMService({ workspaceRoot: workspace, model });
			const events = await Array.fromAsync(
				service.stream([{ role: "user", content: "inspect" }], { agentMode: true }),
			);
			expect(model.doStreamCalls).toHaveLength(2);
			expect(events.at(-1)).toMatchObject({
				type: "done",
				finishReason: limited ? "step-limit" : "stop",
			});
		});
	}

	it("uses resolved model limits and clamps the requested output allowance", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-metadata-"));
		await writeFile(
			join(workspace, "source.ts"),
			"export function example() { return 42; }\n".repeat(100),
		);
		const limits = spyOn(modelRouter, "getModelLimits").mockResolvedValue({
			contextWindow: 32_768,
			maxOutputTokens: 8_192,
		});
		try {
			const model = new MockLanguageModelV4({ doStream: response() });
			const service = createLLMService({ workspaceRoot: workspace, model });
			const events = await Array.fromAsync(
				service.stream([{ role: "user", content: "inspect" }], {
					model: "other/small-model",
					agentMode: true,
				}),
			);
			expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
			expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(8_192);
			expect(limits).toHaveBeenCalledTimes(1);
		} finally {
			limits.mockRestore();
		}
	});

	it("keeps compacted history across approval continuation without duplicating earlier responses", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-compact-approval-"));
		await writeFile(join(workspace, ".env"), "TEST_SECRET=approved\n");
		const limits = spyOn(modelRouter, "getModelLimits").mockResolvedValue({
			contextWindow: 32_768,
			maxOutputTokens: 4_096,
		});
		try {
			const model = new MockLanguageModelV4({
				doStream: [response("getTaskPlan"), response("readFile", { path: ".env" }), response()],
			});
			const service = createLLMService({ workspaceRoot: workspace, model });
			const initial = await Array.fromAsync(
				service.stream(
					[
						{ role: "user", content: "Read the file with approval." },
						{ role: "assistant", content: `OLD-CONTEXT-${"x".repeat(90_000)}` },
						{ role: "assistant", content: "recent context one" },
						{ role: "assistant", content: "recent context two" },
					],
					{ agentMode: true },
				),
			);
			const request = initial.find((event) => event.type === "approval-request");
			if (request?.type !== "approval-request") throw new Error(JSON.stringify(initial));
			const continuation = await Array.fromAsync(
				service.resolveApproval({ approvalId: request.approval.id, approved: true }),
			);
			expect(continuation.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
			const prompt = JSON.stringify(model.doStreamCalls[2]?.prompt);
			expect(prompt).not.toContain("OLD-CONTEXT-");
			expect(prompt.match(/"type":"tool-call","toolCallId":"getTaskPlan"/g)).toHaveLength(1);
			expect(prompt.match(/"type":"tool-call","toolCallId":"readFile"/g)).toHaveLength(1);
			expect(prompt).toContain("TEST_SECRET=approved");
		} finally {
			limits.mockRestore();
		}
	});

	for (const modelId of ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"]) {
		it(`preserves signed thinking and instructions through a plan update and approval for ${modelId}`, async () => {
			const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-signed-"));
			await writeFile(join(workspace, ".env"), "APPROVED=1\n");
			const model = new MockLanguageModelV4({
				doStream: [
					response(
						"updateTaskPlan",
						{
							summary: "PLAN-UPDATE-SENTINEL",
							items: [{ id: "read", title: "Read approved file", status: "in_progress" }],
						},
						true,
					),
					response("readFile", { path: ".env" }, true),
					response(),
				],
			});
			const service = createLLMService({ workspaceRoot: workspace, model });
			const initial = await Array.fromAsync(
				service.stream([{ role: "user", content: "read the approved file" }], {
					provider: "anthropic",
					model: modelId,
					agentMode: true,
					temperature: 0.4,
				}),
			);
			const request = initial.find((event) => event.type === "approval-request");
			if (request?.type !== "approval-request") throw new Error(JSON.stringify(initial));
			const continuation = await Array.fromAsync(
				service.resolveApproval({ approvalId: request.approval.id, approved: true }),
			);
			expect(continuation.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
			expect(model.doStreamCalls).toHaveLength(3);
			const instructions = model.doStreamCalls.map((call) =>
				call.prompt.filter((message) => message.role === "system"),
			);
			expect(instructions[1]).toEqual(instructions[0]);
			expect(instructions[2]).toEqual(instructions[0]);
			for (const call of model.doStreamCalls) expect(call.temperature).toBeUndefined();
			const beforeApproval = JSON.stringify(model.doStreamCalls[1]?.prompt);
			const afterApproval = JSON.stringify(model.doStreamCalls[2]?.prompt);
			expect(beforeApproval).toContain("signed-prefix");
			expect(afterApproval).toContain("signed-prefix");
			expect(afterApproval).toContain("PLAN-UPDATE-SENTINEL");
			expect(afterApproval).toContain("APPROVED=1");
		});
	}

	it("rejects a changed MCP tool catalog before executing an approved signed-history continuation", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-signed-mcp-"));
		let connections = 0;
		let executions = 0;
		let closed = 0;
		const connect = spyOn(mcpRuntime, "connectMCPTools").mockImplementation(async () => ({
			tools: {
				mcp_remote_inspect: tool({
					description: `Remote inspection schema version ${connections++}`,
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return "inspected";
					},
				}),
			},
			approvalTools: new Set(["mcp_remote_inspect"]),
			warnings: [],
			close: async () => {
				closed++;
			},
		}));
		try {
			const model = new MockLanguageModelV4({ doStream: response("mcp_remote_inspect", {}, true) });
			const service = createLLMService({ workspaceRoot: workspace, model });
			const initial = await Array.fromAsync(
				service.stream([{ role: "user", content: "inspect" }], {
					provider: "anthropic",
					model: "anthropic/claude-sonnet-5.5",
					agentMode: true,
				}),
			);
			const request = initial.find((event) => event.type === "approval-request");
			if (request?.type !== "approval-request") throw new Error(JSON.stringify(initial));
			const continuation = await Array.fromAsync(
				service.resolveApproval({ approvalId: request.approval.id, approved: true }),
			);
			expect(continuation.at(-1)).toMatchObject({ type: "error", code: "MODEL_HISTORY_CHANGED" });
			expect(model.doStreamCalls).toHaveLength(1);
			expect(executions).toBe(0);
			expect(closed).toBe(2);
		} finally {
			connect.mockRestore();
		}
	});

	it("sends compatible GPT-6 reasoning and sampling settings to the provider", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-gpt6-"));
		const model = new MockLanguageModelV4({ doStream: response() });
		const service = createLLMService({ workspaceRoot: workspace, model });
		const events = await Array.fromAsync(
			service.stream([{ role: "user", content: "inspect" }], {
				model: "openai/gpt-6-astra",
				agentMode: false,
				reasoningEffort: "none",
				temperature: 0.3,
			}),
		);
		expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
		expect(model.doStreamCalls[0]?.temperature).toBeUndefined();
		expect(model.doStreamCalls[0]?.providerOptions).toMatchObject({
			openai: { reasoningEffort: "low" },
		});
	});
	for (const toolName of ["editFile", "multiEdit", "applyPatch", "writeFile"]) {
		it(`preserves literal source text through ${toolName} and undo`, async () => {
			const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-literal-"));
			const before = "\uFEFFfirst TARGET last\r\n";
			const newText = "$$ $& $` $'";
			const after = `\uFEFFfirst ${newText} last\r\n`;
			await writeFile(join(workspace, "source.txt"), before);
			const input =
				toolName === "multiEdit"
					? {
							path: "source.txt",
							edits: [
								{ oldText: "TARGET", newText: "INTERMEDIATE" },
								{ oldText: "INTERMEDIATE", newText },
							],
						}
					: toolName === "applyPatch"
						? { operations: [{ type: "replace", path: "source.txt", oldText: "TARGET", newText }] }
						: toolName === "writeFile"
							? { path: "source.txt", content: after }
							: { path: "source.txt", oldText: "TARGET", newText };
			const usage = {
				inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			};
			const calls = [
				{
					toolName: "updateTaskPlan",
					input: { items: [{ id: "edit", title: "edit source", status: "in_progress" }] },
				},
				{ toolName, input },
			];
			let step = 0;
			const model = new MockLanguageModelV4({
				doStream: async () => {
					const call = calls[step++];
					return {
						stream: stream([
							{ type: "stream-start", warnings: [] },
							...(call
								? [
										{
											type: "tool-call" as const,
											toolCallId: `call-${step}`,
											toolName: call.toolName,
											input: JSON.stringify(call.input),
										},
									]
								: []),
							{
								type: "finish",
								finishReason: {
									unified: call ? "tool-calls" : "stop",
									raw: call ? "tool_calls" : "stop",
								},
								usage,
							},
						]),
					};
				},
			});
			const service = createLLMService({ workspaceRoot: workspace, model });
			const events = await Array.fromAsync(
				service.stream([{ role: "user", content: "edit source" }], { agentMode: true }),
			);
			expect(
				events.some(
					(event) =>
						event.type === "error" || (event.type === "tool-result" && event.toolResult.isError),
				),
			).toBe(false);
			expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe(after);
			await service.undoLastPatch();
			expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe(before);
		});
	}

	it("coordinates dynamically allowed roots with other workspace mutations", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-root-lock-"));
		const shared = join(workspace, "shared");
		const service = createLLMService({ workspaceRoot: join(workspace, "primary") });
		service.addAllowedPath(shared);
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const otherMutation = workspaceMutationCoordinator.run(shared, () => gate);
		let undoFinished = false;
		const undo = service.undoLastPatch().then((result) => {
			undoFinished = true;
			return result;
		});
		try {
			await Bun.sleep(0);
			expect(undoFinished).toBe(false);
		} finally {
			release();
			await otherMutation;
		}
		expect(await undo).toContain("No Night Code patch checkpoint");
	});

	it("cleans up abort listeners when closed at the startup event", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-close-"));
		const service = createLLMService({
			workspaceRoot: workspace,
			model: new MockLanguageModelV4(),
		});
		const controller = new AbortController();
		const removeListener = spyOn(controller.signal, "removeEventListener");
		try {
			const run = service.stream(
				[{ role: "user", content: "start" }],
				{},
				{ abortSignal: controller.signal },
			);
			await run.next();
			await run.return(undefined);
			expect(removeListener).toHaveBeenCalled();
			expect(service.isBusy).toBe(false);
		} finally {
			removeListener.mockRestore();
		}
	});

	it("never follows a provider stream error with a successful done event", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-error-"));
		const service = createLLMService({
			workspaceRoot: workspace,
			model: new MockLanguageModelV4({
				doStream: {
					stream: stream([
						{ type: "stream-start", warnings: [] },
						{ type: "error", error: new Error("provider stream failed") },
					]),
				},
			}),
		});
		const events = await Array.fromAsync(
			service.stream([{ role: "user", content: "start" }], { agentMode: false }),
		);
		expect(events.at(-1)).toMatchObject({ type: "error" });
		expect(events.some((event) => event.type === "done")).toBe(false);
		expect(service.isBusy).toBe(false);
	});

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
		expect(chunks.at(-1)).toMatchObject({
			type: "done",
			finishReason: "stop",
			usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, cachedInputTokens: 0 },
		});
		expect(chunks.map((chunk) => chunk.sequence)).toEqual(chunks.map((_, index) => index));
		const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
		expect(prompt).toContain("hello");
		expect(prompt).toContain("TRUSTED-SERVICE-INSTRUCTIONS");
		expect(prompt).not.toContain("CALLER-SYSTEM-POISON");
		expect(prompt).not.toContain("UI-NOTICE-POISON");
		expect(prompt).not.toContain("CALLER-CONFIG-POISON");
	});

	it("passes current reasoning and verbosity controls to the OpenAI Responses provider", async () => {
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
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-options-"));
		const service = createLLMService({ workspaceRoot: workspace, model });

		for await (const _chunk of service.stream([{ role: "user", content: "inspect" }], {
			agentMode: false,
			reasoningEffort: "max",
			textVerbosity: "high",
		})) {
			// Drain the run so the mock captures provider options.
		}

		expect(model.doStreamCalls[0]?.providerOptions).toMatchObject({
			openai: { reasoningEffort: "max", textVerbosity: "high" },
		});
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

		const chunks = [];
		for await (const chunk of service.stream([{ role: "user", content: "write twice" }], {
			agentMode: true,
			approvalMode: "on-risk",
		})) {
			chunks.push(chunk);
		}

		expect(chunks.some((chunk) => chunk.type === "approval-request")).toBe(false);
		expect(chunks.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
		expect(service.getPendingApprovals()).toEqual([]);

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
						toolCallId: "read-public",
						toolName: "readFile",
						input: JSON.stringify({ path: "README.md" }),
					},
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
		await writeFile(join(workspace, "README.md"), "Public documentation");
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
		expect(chunks.filter((chunk) => chunk.type === "approval-request")).toHaveLength(1);
		expect(service.getPendingApprovals()).toHaveLength(1);
		expect(service.getPendingApprovals()[0]?.toolCallId).toBe("read-secret");
		expect(chunks.at(-1)).toMatchObject({ type: "done", finishReason: "approval-required" });
	});

	it("does not leave automatically denied tools pending for user approval", async () => {
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
							toolCallId: "read-secret",
							toolName: "readFile",
							input: JSON.stringify({ path: ".env" }),
						},
						{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
					]),
				},
				{
					stream: stream([
						{ type: "stream-start", warnings: [] },
						{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
					]),
				},
			],
		});
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-agent-denied-"));
		await mkdir(join(workspace, ".nightcode"));
		await writeFile(join(workspace, ".nightcode", "config.yaml"), "approvalMode: never\n");
		await writeFile(join(workspace, ".env"), "TOKEN=do-not-read");
		const service = createLLMService({ workspaceRoot: workspace, model });
		const chunks = await Array.fromAsync(
			service.stream([{ role: "user", content: "read .env" }], { agentMode: true }),
		);
		expect(chunks.some((chunk) => chunk.type === "approval-request")).toBe(false);
		expect(chunks.find((chunk) => chunk.type === "approval-response")).toMatchObject({
			approval: { approved: false },
		});
		expect(service.getPendingApprovals()).toEqual([]);
		expect(chunks.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
		expect(JSON.stringify(chunks)).not.toContain("TOKEN=do-not-read");
		expect(JSON.stringify(model.doStreamCalls)).not.toContain("TOKEN=do-not-read");
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
