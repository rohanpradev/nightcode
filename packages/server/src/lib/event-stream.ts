import type { LLMStreamChunk } from "@nightcode/shared";

/** Pull one event at a time so slow HTTP clients cannot grow an unbounded queue. */
export function ndjsonResponse(
	createStream: (signal: AbortSignal) => AsyncGenerator<LLMStreamChunk>,
	requestSignal: AbortSignal,
	headers: Record<string, string> = {},
): Response {
	const abortController = new AbortController();
	const encoder = new TextEncoder();
	let iterator: AsyncGenerator<LLMStreamChunk> | undefined;
	let closed = false;
	let cleanup: Promise<unknown> | undefined;
	const dispose = () => {
		requestSignal.removeEventListener("abort", onRequestAbort);
		cleanup ??= iterator?.return(undefined) ?? Promise.resolve();
		return cleanup;
	};
	let streamController: ReadableStreamDefaultController<Uint8Array>;
	const onRequestAbort = () => {
		if (closed) return;
		closed = true;
		const reason = requestSignal.reason ?? new Error("request aborted");
		abortController.abort(reason);
		streamController.error(reason);
		void dispose().catch(() => {});
	};
	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				streamController = controller;
				if (requestSignal.aborted) onRequestAbort();
				else requestSignal.addEventListener("abort", onRequestAbort, { once: true });
			},
			async pull(controller) {
				if (closed) return;
				try {
					iterator ??= createStream(abortController.signal);
					const { done, value } = await iterator.next();
					if (closed) return;
					if (!done) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
					if (done || ["done", "error", "aborted"].includes(value.type)) {
						closed = true;
						controller.close();
						await dispose();
					}
				} catch (error) {
					if (!closed) {
						closed = true;
						controller.enqueue(
							encoder.encode(
								`${JSON.stringify({
									type: "error",
									error: error instanceof Error ? error.message : String(error),
									code: "STREAM_FAILED",
								})}\n`,
							),
						);
						controller.close();
					}
					abortController.abort(error);
					await dispose().catch(() => {});
				}
			},
			async cancel(reason) {
				closed = true;
				abortController.abort(reason ?? new Error("response consumer cancelled"));
				await dispose().catch(() => {});
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(stream, {
		headers: {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			"X-Content-Type-Options": "nosniff",
			...headers,
		},
	});
}
