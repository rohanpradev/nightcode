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

async function* parseEventStream(response: {
	ok: boolean;
	status: number;
	body: ReadableStream<Uint8Array> | null;
	text(): Promise<string>;
}): AsyncGenerator<LLMStreamChunk> {
	if (!response.ok || !response.body) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Nightcode server request failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
		);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.trim()) continue;
			yield llmStreamChunkSchema.parse(JSON.parse(line));
		}
	}

	const trailing = buffer.trim();
	if (trailing) {
		yield llmStreamChunkSchema.parse(JSON.parse(trailing));
	}
}
