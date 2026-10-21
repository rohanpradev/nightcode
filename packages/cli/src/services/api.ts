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
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "";
	let finished = false;
	let terminal = false;
	const maxLineChars = 8 * 1024 * 1024;
	const parseLine = (line: string) => {
		if (line.length > maxLineChars) throw new Error("Nightcode stream event exceeds 8 MiB");
		const event = llmStreamChunkSchema.parse(JSON.parse(line));
		terminal = ["done", "error", "aborted"].includes(event.type);
		return event;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				buffer += decoder.decode();
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				yield parseLine(line);
				if (terminal) return;
			}
			if (buffer.length > maxLineChars) throw new Error("Nightcode stream event exceeds 8 MiB");
		}

		const trailing = buffer.trim();
		if (trailing) {
			yield parseLine(trailing);
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
