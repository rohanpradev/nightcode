import { describe, expect, it } from "bun:test";
import type { LLMStreamChunk } from "@nightcode/shared";
import { agentRunResultSchema } from "@nightcode/shared";
import type { LLMService } from "./agent-runtime";
import { CodingAgentService } from "./agents";

function serviceWith(chunks: LLMStreamChunk[]): LLMService {
	return {
		async *stream() {
			for (const chunk of chunks) yield chunk;
		},
	} as unknown as LLMService;
}

describe("CodingAgentService", () => {
	it.each([true, false])(
		"retains known step usage without double-counting terminal totals (%s)",
		async (completed) => {
			const events: LLMStreamChunk[] = [
				{
					type: "step-finish",
					step: 0,
					finishReason: "tool-calls",
					usage: { inputTokens: 10, outputTokens: 2 },
				},
				{
					type: "step-finish",
					step: 1,
					finishReason: "stop",
					usage: { inputTokens: 20, outputTokens: 3 },
				},
				completed
					? {
							type: "done",
							finishReason: "stop",
							usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
						}
					: { type: "error", error: "connection lost" },
			];
			const result = await new CodingAgentService(serviceWith(events)).run({
				messages: [{ role: "user", content: "fix" }],
			});
			expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 5, totalTokens: 35 });
			expect(result.status).toBe(completed ? "completed" : "failed");
		},
	);

	it.each(["length", "tool-calls", "content-filter", "error", "unknown", undefined])(
		"does not score %s termination as a completed task",
		async (finishReason) => {
			const result = await new CodingAgentService(
				serviceWith([{ type: "done", finishReason }]),
			).run({ messages: [{ role: "user", content: "fix" }] });
			expect(result.status).toBe("failed");
			expect(result.error).toContain("did not complete");
		},
	);

	it.each(["error", "aborted"] as const)(
		"preserves %s despite a later finish event",
		async (type) => {
			const terminal: LLMStreamChunk =
				type === "error" ? { type, error: "provider failed" } : { type, reason: "cancelled" };
			const result = await new CodingAgentService(
				serviceWith([terminal, { type: "done", finishReason: "stop" }]),
			).run({ messages: [{ role: "user", content: "fix" }] });
			expect(result.status).toBe(type === "error" ? "failed" : "aborted");
			expect(result.error).toBeTruthy();
		},
	);

	it("returns partial output and diagnostics when the iterator throws", async () => {
		const service = {
			async *stream() {
				yield { type: "text", text: "partial" } as const;
				throw new Error("connection lost");
			},
		} as unknown as LLMService;
		const events: LLMStreamChunk[] = [];
		const result = await new CodingAgentService(service).run({
			messages: [{ role: "user", content: "fix" }],
			onEvent: (event) => {
				events.push(event);
			},
		});
		expect(result).toMatchObject({ status: "failed", text: "partial", error: "connection lost" });
		expect(events).toHaveLength(1);
	});

	it("returns a complete, evaluation-ready outcome", async () => {
		const service = new CodingAgentService(
			serviceWith([
				{ type: "step-start", step: 1 },
				{ type: "text", text: "fixed" },
				{
					type: "tool-call",
					toolCall: { name: "readFile", args: { path: "src/index.ts" } },
				},
				{
					type: "done",
					finishReason: "stop",
					usage: {
						inputTokens: 10,
						outputTokens: 5,
						totalTokens: 15,
						reasoningTokens: 2,
						cachedInputTokens: 4,
					},
				},
			]),
		);

		const result = await service.run({ messages: [{ role: "user", content: "fix it" }] });

		expect(agentRunResultSchema.parse(result)).toMatchObject({
			status: "completed",
			text: "fixed",
			toolCalls: 1,
			steps: 1,
			approvalsRequired: 0,
			finishReason: "stop",
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
				reasoningTokens: 2,
				cachedInputTokens: 4,
			},
		});
	});

	it("does not report partial output as success after a stream error", async () => {
		const service = new CodingAgentService(
			serviceWith([
				{ type: "text", text: "partial" },
				{ type: "error", error: "provider unavailable", code: "RUN_FAILED" },
			]),
		);

		const result = await service.run({ messages: [{ role: "user", content: "fix it" }] });

		expect(result).toMatchObject({
			status: "failed",
			text: "partial",
			error: "provider unavailable",
		});
	});

	it("surfaces approval-required runs as incomplete", async () => {
		const service = new CodingAgentService(
			serviceWith([
				{
					type: "approval-request",
					approval: {
						id: "approval-1",
						toolCallId: "call-1",
						toolName: "shell",
						args: { command: "bun test" },
					},
				},
				{ type: "done", finishReason: "approval-required" },
			]),
		);

		const result = await service.run({ messages: [{ role: "user", content: "test it" }] });

		expect(result).toMatchObject({
			status: "approval-required",
			approvalsRequired: 1,
			finishReason: "approval-required",
		});
	});
});
