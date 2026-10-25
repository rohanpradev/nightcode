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

	it.each([false, true])(
		"limits Unicode events by wire bytes (fragmented: %s)",
		async (fragmented) => {
			const payload = new TextEncoder().encode(
				`${JSON.stringify({ type: "text", text: "🌙".repeat(2 * 1024 * 1024) })}\n{"type":"done"}\n`,
			);
			let offset = 0;
			let cancelled = false;
			const response = new Response(
				new ReadableStream({
					pull(controller) {
						if (offset === payload.length) return controller.close();
						const end = fragmented ? Math.min(offset + 64 * 1024, payload.length) : payload.length;
						controller.enqueue(payload.subarray(offset, end));
						offset = end;
					},
					cancel() {
						cancelled = true;
					},
				}),
			);
			await expect(Array.fromAsync(parseEventStream(response))).rejects.toThrow("exceeds 8 MiB");
			expect(cancelled).toBe(true);
			expect(response.body?.locked).toBe(false);
		},
	);

	it("applies the byte limit per event, including an event exactly at the limit", async () => {
		const maxBytes = 8 * 1024 * 1024;
		const overhead = JSON.stringify({ type: "text", text: "" }).length;
		const text = "x".repeat(maxBytes - overhead);
		const payload = `${JSON.stringify({ type: "text", text })}\n{"type":"text","text":"next"}\n{"type":"done"}\n`;
		expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(maxBytes);
		const events = await Array.fromAsync(parseEventStream(new Response(payload)));
		expect(events).toHaveLength(3);
		expect(events[0]).toEqual({ type: "text", text });
		expect(events[1]).toEqual({ type: "text", text: "next" });
		expect(events[2]).toEqual({ type: "done" });
	});

	it("preserves BOM and CRLF handling when each byte arrives separately", async () => {
		const payload = new TextEncoder().encode(
			'\uFEFF\r\n{"type":"text","text":"🌙"}\r\n{"type":"done"}',
		);
		let offset = 0;
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					if (offset < payload.length) controller.enqueue(payload.subarray(offset, ++offset));
					else controller.close();
				},
			}),
		);
		expect(await Array.fromAsync(parseEventStream(response))).toEqual([
			{ type: "text", text: "🌙" },
			{ type: "done" },
		]);
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
