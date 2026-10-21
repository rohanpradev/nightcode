import { describe, expect, it } from "bun:test";
import { parseEventStream } from "./api";

describe("remote event parser", () => {
	it.each(["", '{"type":"text","text":"partial"}\n'])(
		"rejects a stream that closes without a terminal event",
		async (payload) => {
			await expect(Array.fromAsync(parseEventStream(new Response(payload)))).rejects.toThrow(
				"before a terminal event",
			);
		},
	);

	it("stops and cancels at a terminal event even if the server keeps the connection open", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"type":"done","finishReason":"stop"}\n'));
				},
				cancel() {
					cancelled = true;
				},
			}),
		);
		expect(await Array.fromAsync(parseEventStream(response))).toEqual([
			{ type: "done", finishReason: "stop" },
		]);
		expect(cancelled).toBe(true);
		expect(response.body?.locked).toBe(false);
	});

	it("bounds error response details and cancels an oversized body", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(32 * 1024).fill(120));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 502 },
		);
		await expect(Array.fromAsync(parseEventStream(response))).rejects.toThrow(
			`HTTP 502 — ${"x".repeat(16 * 1024)} [truncated]`,
		);
		expect(cancelled).toBe(true);
		expect(response.body?.locked).toBe(false);
	});

	it("rejects invalid UTF-8 instead of silently replacing corrupted text", async () => {
		const response = new Response(new Uint8Array([0xff]));
		await expect(Array.fromAsync(parseEventStream(response))).rejects.toThrow();
		expect(response.body?.locked).toBe(false);
	});

	it("decodes UTF-8 across byte boundaries and accepts an unterminated final line", async () => {
		const bytes = new TextEncoder().encode(
			'{"type":"text","text":"hello 🌙"}\n{"type":"done","finishReason":"stop"}',
		);
		let offset = 0;
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
					else controller.close();
				},
			}),
		);
		const events = await Array.fromAsync(parseEventStream(response));
		expect(events).toEqual([
			{ type: "text", text: "hello 🌙" },
			{ type: "done", finishReason: "stop" },
		]);
		expect(response.body?.locked).toBe(false);
	});

	it("cancels the response body when the caller stops reading", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new TextEncoder().encode('{"type":"text","text":"hello"}\n'));
				},
				cancel() {
					cancelled = true;
				},
			}),
		);
		for await (const _event of parseEventStream(response)) break;
		expect(cancelled).toBe(true);
		expect(response.body?.locked).toBe(false);
	});

	it.each(["not json\n", '{"type":"invalid"}\n', "x".repeat(8 * 1024 * 1024 + 1)])(
		"cancels malformed or oversized responses",
		async (payload) => {
			let cancelled = false;
			const response = new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(payload));
					},
					cancel() {
						cancelled = true;
					},
				}),
			);
			await expect(Array.fromAsync(parseEventStream(response))).rejects.toThrow();
			expect(cancelled).toBe(true);
			expect(response.body?.locked).toBe(false);
		},
	);
});
