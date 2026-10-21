import { describe, expect, it } from "bun:test";
import { ndjsonResponse } from "./event-stream";

describe("HTTP event streaming", () => {
	it("pulls only on demand and closes the generator when the reader cancels", async () => {
		let produced = 0;
		let finalized = false;
		let signal: AbortSignal | undefined;
		const response = ndjsonResponse(async function* (inputSignal) {
			signal = inputSignal;
			try {
				for (let i = 0; i < 100; i++) {
					produced++;
					yield { type: "text", text: String(i) };
				}
			} finally {
				finalized = true;
			}
		}, new AbortController().signal);
		expect(produced).toBe(0);
		if (!response.body) throw new Error("Missing response body");
		const reader = response.body.getReader();
		await reader.read();
		await Promise.resolve();
		expect(produced).toBe(1);
		await reader.cancel();
		expect(finalized).toBe(true);
		expect(signal?.aborted).toBe(true);
	});

	it("finalizes at the terminal event without another consumer read", async () => {
		let finalized = false;
		const response = ndjsonResponse(
			async function* () {
				try {
					yield { type: "done", finishReason: "stop" };
				} finally {
					finalized = true;
				}
			},
			new AbortController().signal,
			{ "X-Nightcode-Session-Id": "test" },
		);
		const text = await response.text();
		expect(JSON.parse(text)).toEqual({ type: "done", finishReason: "stop" });
		expect(finalized).toBe(true);
		expect(response.headers.get("X-Nightcode-Session-Id")).toBe("test");
	});

	it("cleans up a parked generator when the HTTP request aborts", async () => {
		const request = new AbortController();
		let finalized = false;
		const response = ndjsonResponse(async function* () {
			try {
				yield { type: "text", text: "partial" };
			} finally {
				finalized = true;
			}
		}, request.signal);
		if (!response.body) throw new Error("Missing response body");
		const reader = response.body.getReader();
		await reader.read();
		request.abort(new Error("disconnected"));
		await expect(reader.read()).rejects.toThrow("disconnected");
		expect(finalized).toBe(true);
	});

	it("turns thrown generator errors into an NDJSON terminal error", async () => {
		const response = ndjsonResponse(async function* () {
			yield { type: "text", text: "partial" };
			throw new Error("provider unavailable");
		}, new AbortController().signal);
		const events = (await response.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(events.at(-1)).toMatchObject({ type: "error", code: "STREAM_FAILED" });
	});

	it("never starts an already aborted request", async () => {
		let started = false;
		const response = ndjsonResponse(
			async function* () {
				started = true;
				yield { type: "text", text: "unexpected" };
			},
			AbortSignal.abort(new Error("already cancelled")),
		);
		await expect(response.text()).rejects.toThrow("already cancelled");
		expect(started).toBe(false);
	});
});
