import { describe, expect, it } from "bun:test";
import type { ModelMessage, StepResult, ToolSet } from "ai";
import {
	ContextBudgetExceededError,
	compactLoopMessages,
	createLoopControl,
	estimateLoopTokens,
	loopHistoryBudget,
} from "./agent-loop-control";

function step(
	id: string,
	toolName = "readFile",
	input: unknown = { path: "source.ts" },
	output: unknown = "unchanged",
	error?: Error,
): Pick<StepResult<ToolSet>, "toolCalls" | "content"> {
	const call = { type: "tool-call" as const, toolCallId: id, toolName, input };
	return {
		toolCalls: [call],
		content: [
			call,
			error ? { ...call, type: "tool-error", error } : { ...call, type: "tool-result", output },
		],
	};
}

function exchange(id: string, text: string): [ModelMessage, ModelMessage] {
	return [
		{
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: id, toolName: "readFile", input: { path: id } }],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: id,
					toolName: "readFile",
					output: { type: "text", value: text },
				},
			],
		},
	];
}

describe("agent loop control", () => {
	it("detects repeated completed reads despite fresh call IDs and reordered input keys", () => {
		const control = createLoopControl(20);
		const steps = Array.from({ length: 4 }, (_, index) =>
			step(`call-${index}`, "readLines", index % 2 ? { end: 4, start: 1 } : { start: 1, end: 4 }),
		);
		expect(control.stopWhen({ steps: steps.slice(0, 3) })).toBe(false);
		expect(control.stopWhen({ steps })).toBe(true);
		expect(control.stopReason).toBe("no-progress");
	});

	it("resets the stalled window when read output changes", () => {
		const control = createLoopControl(20);
		const steps = Array.from({ length: 6 }, (_, index) =>
			step(`call-${index}`, "readFile", { path: "source.ts" }, index < 3 ? "old" : "new"),
		);
		expect(control.stopWhen({ steps })).toBe(false);
		expect(control.stopReason).toBeUndefined();
		steps.push(step("call-6", "readFile", { path: "source.ts" }, "new"));
		expect(control.stopWhen({ steps })).toBe(true);
	});

	for (const toolName of ["writeFile", "applyPatch", "updateTaskPlan", "shell", "mcp_counter"]) {
		it(`does not mistake successful ${toolName} acknowledgements for stalled state`, () => {
			const control = createLoopControl(20);
			const steps = Array.from({ length: 6 }, (_, index) => step(`call-${index}`, toolName));
			expect(control.stopWhen({ steps })).toBe(false);
		});
	}

	it("bounds repeatedly failing mutations without treating each Error object as different", () => {
		const control = createLoopControl(20);
		const steps = Array.from({ length: 4 }, (_, index) =>
			step(`call-${index}`, "applyPatch", {}, undefined, new Error("target does not match")),
		);
		expect(control.stopWhen({ steps })).toBe(true);
		expect(control.stopReason).toBe("no-progress");
	});

	it("reports a step limit independently of the provider finish reason", () => {
		const control = createLoopControl(2);
		expect(
			control.stopWhen({ steps: [step("1"), step("2", "readFile", { path: "next.ts" })] }),
		).toBe(true);
		expect(control.stopReason).toBe("step-limit");
	});

	it("does not classify pending approvals or unresolved tool calls as no progress", () => {
		const control = createLoopControl(20);
		const completed = step("pending");
		const pending = {
			...completed,
			content: completed.content.filter((part) => part.type === "tool-call"),
		};
		expect(control.stopWhen({ steps: [pending, pending, pending, pending] })).toBe(false);
	});
});

describe("agent history budget", () => {
	it("reserves model headroom, instructions, schema tokens and the full output allowance", () => {
		const budget = loopHistoryBudget({
			contextWindow: 32_000,
			maxOutputTokens: 4_000,
			instructions: "instructions".repeat(1_000),
			toolSchemaTokens: 2_000,
		});
		expect(budget + 4_000 + 2_000 + estimateLoopTokens("instructions".repeat(1_000))).toBeLessThan(
			25_600,
		);
		expect(
			loopHistoryBudget({
				contextWindow: 1_000,
				maxOutputTokens: 1_000,
				instructions: "",
				toolSchemaTokens: 0,
			}),
		).toBe(0);
	});

	it("removes complete old exchanges while retaining all user instructions and recent results", () => {
		const user: ModelMessage = {
			role: "user",
			content: "Implement the feature and preserve public APIs.",
		};
		const correction: ModelMessage = { role: "user", content: "Also cover the empty case." };
		const recent = [
			...exchange("recent-1", "latest file"),
			...exchange("recent-2", "latest check"),
		];
		const messages = [
			user,
			...exchange("old-1", "old data".repeat(2_000)),
			correction,
			...exchange("old-2", "old data".repeat(2_000)),
			...recent,
		];
		const original = JSON.stringify(messages);
		const budget = estimateLoopTokens([user, correction, ...recent]) + 300;
		const compacted = compactLoopMessages(messages, budget);
		expect(compacted).toContain(user);
		expect(compacted).toContain(correction);
		expect(JSON.stringify(compacted)).not.toContain("old-1");
		expect(JSON.stringify(compacted)).not.toContain("old-2");
		for (const message of recent) expect(compacted).toContain(message);
		expect(JSON.stringify(compacted)).toContain("Local context compaction");
		expect(estimateLoopTokens(compacted)).toBeLessThanOrEqual(budget);
		expect(JSON.stringify(messages)).toBe(original);
	});

	it("compacts completed approvals together with their decisions and execution results", () => {
		const user: ModelMessage = { role: "user", content: "Read the approved file." };
		const approved = exchange("approved", "approved output");
		const assistant = approved[0];
		if (assistant.role !== "assistant" || typeof assistant.content === "string")
			throw new Error("fixture");
		assistant.content.push({
			type: "tool-approval-request",
			approvalId: "approval",
			toolCallId: "approved",
		});
		const decision: ModelMessage = {
			role: "tool",
			content: [{ type: "tool-approval-response", approvalId: "approval", approved: true }],
		};
		const protectedMessages = [approved[0], decision, approved[1]];
		const recent = [...exchange("recent-1", "next"), ...exchange("recent-2", "last")];
		const messages = [
			user,
			...protectedMessages,
			...exchange("large-old", "x".repeat(30_000)),
			...recent,
		];
		const budget = estimateLoopTokens([user, ...protectedMessages, ...recent]) + 300;
		const compacted = compactLoopMessages(messages, budget);
		for (const message of protectedMessages) expect(compacted).not.toContain(message);
		expect(JSON.stringify(compacted)).not.toContain("large-old");
	});

	for (const approved of [undefined, true] as const) {
		it(`retains a pending approval chain with decision ${approved}`, () => {
			const user: ModelMessage = { role: "user", content: "Read only when approved." };
			const call: ModelMessage = {
				role: "assistant",
				content: [
					{ type: "tool-call", toolCallId: "pending", toolName: "readFile", input: {} },
					{ type: "tool-approval-request", toolCallId: "pending", approvalId: "pending-id" },
				],
			};
			const decision: ModelMessage[] =
				approved === undefined
					? []
					: [
							{
								role: "tool",
								content: [{ type: "tool-approval-response", approvalId: "pending-id", approved }],
							},
						];
			const recent = [...exchange("recent-1", "next"), ...exchange("recent-2", "last")];
			const messages = [user, call, ...decision, ...exchange("old", "x".repeat(30_000)), ...recent];
			const compacted = compactLoopMessages(
				messages,
				estimateLoopTokens([user, call, ...decision, ...recent]) + 300,
			);
			expect(compacted).toContain(call);
			for (const message of decision) expect(compacted).toContain(message);
			expect(JSON.stringify(compacted)).not.toContain('"old"');
		});
	}

	it("compacts denied approvals without waiting for an execution result", () => {
		const user: ModelMessage = { role: "user", content: "Continue after denying." };
		const denied: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool-call", toolCallId: "denied", toolName: "readFile", input: {} },
					{ type: "tool-approval-request", toolCallId: "denied", approvalId: "denial" },
				],
			},
			{
				role: "tool",
				content: [{ type: "tool-approval-response", approvalId: "denial", approved: false }],
			},
		];
		const recent = [...exchange("recent-1", "next"), ...exchange("recent-2", "last")];
		const compacted = compactLoopMessages(
			[user, ...denied, ...exchange("old", "x".repeat(30_000)), ...recent],
			estimateLoopTokens([user, ...recent]) + 300,
		);
		for (const message of denied) expect(compacted).not.toContain(message);
	});

	it("compacts deferred provider results atomically with their original calls", () => {
		const deferred = exchange("deferred", "delayed result");
		const user: ModelMessage = { role: "user", content: "Keep the delayed result." };
		const dependencyChain = [
			deferred[0],
			{ role: "assistant" as const, content: "waiting" },
			deferred[1],
		];
		const recent = [...exchange("recent-1", "next"), ...exchange("recent-2", "last")];
		const messages = [
			user,
			...dependencyChain,
			...exchange("large-old", "x".repeat(30_000)),
			...recent,
		];
		const compacted = compactLoopMessages(
			messages,
			estimateLoopTokens([user, ...dependencyChain, ...recent]) + 300,
		);
		for (const message of dependencyChain) expect(compacted).not.toContain(message);
	});

	it("rejects irreducible user or current-step context instead of truncating it", () => {
		const user: ModelMessage = { role: "user", content: "x".repeat(10_000) };
		expect(() => compactLoopMessages([user], 100)).toThrow(ContextBudgetExceededError);
		expect(user.content).toHaveLength(10_000);
	});

	it("keeps the same message array when no compaction is needed", () => {
		const messages: ModelMessage[] = [{ role: "user", content: "small request" }];
		expect(compactLoopMessages(messages, 1_000)).toBe(messages);
	});
});
