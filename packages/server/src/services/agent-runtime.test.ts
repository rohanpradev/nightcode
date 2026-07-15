import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { createLLMService } from "./agent-runtime";

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
		const chunks = [];
		for await (const chunk of service.stream(
			[
				{ role: "system", content: "CALLER-SYSTEM-POISON" },
				{ role: "notice", content: "UI-NOTICE-POISON" },
				{ role: "user", content: "hello" },
			],
			{ agentMode: false },
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
		expect(prompt).not.toContain("CALLER-SYSTEM-POISON");
		expect(prompt).not.toContain("UI-NOTICE-POISON");
	});
});
