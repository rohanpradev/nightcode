import type { AppType } from "@nightcode/server";
import {
	type ApprovalRequest,
	type ChatRequest,
	type LLMStreamChunk,
	llmStreamChunkSchema,
} from "@nightcode/shared";

import { hc } from "hono/client";

const SERVER_URL = process.env.NIGHTCODE_SERVER_URL ?? "http://localhost:3000";
const API_TOKEN = process.env.NIGHTCODE_API_TOKEN?.trim();

export type Client = ReturnType<typeof hc<AppType>>;

export const hcWithType = (...args: Parameters<typeof hc>): Client => hc<AppType>(...args);

export const api = hcWithType(
	SERVER_URL,
	API_TOKEN ? { headers: { Authorization: `Bearer ${API_TOKEN}` } } : undefined,
);

export async function* streamChat(
	request: ChatRequest,
	abortSignal?: AbortSignal,
): AsyncGenerator<LLMStreamChunk> {
	const response = await api.chat.$post({ json: request }, { init: { signal: abortSignal } });
	yield* parseEventStream(response);
}

export async function* resolveRemoteApproval(
	request: ApprovalRequest,
	abortSignal?: AbortSignal,
): AsyncGenerator<LLMStreamChunk> {
	const response = await api.approvals.$post({ json: request }, { init: { signal: abortSignal } });
	yield* parseEventStream(response);
}

export async function* parseEventStream(response: {
	ok: boolean;
	status: number;
	body: ReadableStream<Uint8Array> | null;
	text(): Promise<string>;
}): AsyncGenerator<LLMStreamChunk> {
	if (!response.ok || !response.body) {
		const detail = await readErrorDetail(response.body).catch(() => "");
		throw new Error(
			`Nightcode server request failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
		);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const maxLineBytes = 8 * 1024 * 1024;
	let buffer = new Uint8Array(0);
	let bufferedBytes = 0;
	let firstLine = true;
	let finished = false;
	let terminal = false;
	const append = (part: Uint8Array) => {
		const required = bufferedBytes + part.byteLength;
		if (required > maxLineBytes) throw new Error("Nightcode stream event exceeds 8 MiB");
		if (required > buffer.byteLength) {
			const grown = new Uint8Array(
				Math.min(maxLineBytes, Math.max(required, buffer.byteLength * 2, 4096)),
			);
			grown.set(buffer.subarray(0, bufferedBytes));
			buffer = grown;
		}
		buffer.set(part, bufferedBytes);
		bufferedBytes = required;
	};
	const parseLine = (bytes: Uint8Array) => {
		if (bytes.byteLength > maxLineBytes) throw new Error("Nightcode stream event exceeds 8 MiB");
		let line = decoder.decode(bytes);
		if (firstLine) {
			firstLine = false;
			if (line.startsWith("\uFEFF")) line = line.slice(1);
		}
		if (!line.trim()) return;
		const event = llmStreamChunkSchema.parse(JSON.parse(line));
		terminal = ["done", "error", "aborted"].includes(event.type);
		return event;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				break;
			}

			// Frame bytes before decoding: the limit is on UTF-8 wire size, and a
			// fragmented event is copied once per chunk instead of repeatedly split.
			let offset = 0;
			while (offset < value.byteLength) {
				const newline = value.indexOf(10, offset);
				const end = newline < 0 ? value.byteLength : newline;
				const part = value.subarray(offset, end);
				if (newline < 0) {
					append(part);
					break;
				}
				let line = part;
				if (bufferedBytes > 0) {
					append(part);
					line = buffer.subarray(0, bufferedBytes);
				}
				const event = parseLine(line);
				bufferedBytes = 0;
				offset = newline + 1;
				if (!event) continue;
				yield event;
				if (terminal) return;
			}
		}

		if (bufferedBytes > 0) {
			const event = parseLine(buffer.subarray(0, bufferedBytes));
			if (event) yield event;
		}
		if (!terminal) throw new Error("Nightcode stream ended before a terminal event");
	} finally {
		if (!finished) await reader.cancel("event stream consumer closed").catch(() => {});
		reader.releaseLock();
	}
}

/** Keep a proxy/server error from buffering an arbitrarily large response. */
async function readErrorDetail(body: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const maxBytes = 16 * 1024;
	let bytes = 0;
	let detail = "";
	let finished = false;
	try {
		while (bytes < maxBytes) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				break;
			}
			const chunk = value.subarray(0, maxBytes - bytes);
			bytes += chunk.byteLength;
			detail += decoder.decode(chunk, { stream: true });
		}
		return `${detail}${decoder.decode()}${finished ? "" : " [truncated]"}`;
	} finally {
		if (!finished) await reader.cancel("error response limit reached").catch(() => {});
		reader.releaseLock();
	}
}
