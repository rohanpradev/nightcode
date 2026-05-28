import type { AppType } from "@nightcode/server";
import { type ChatRequest, type LLMStreamChunk, llmStreamChunkSchema } from "@nightcode/shared";

import { hc } from "hono/client";

const SERVER_URL = process.env.NIGHTCODE_SERVER_URL ?? "http://localhost:3000";

export type Client = ReturnType<typeof hc<AppType>>;

export const hcWithType = (...args: Parameters<typeof hc>): Client => hc<AppType>(...args);

export const api = hcWithType(SERVER_URL);

export async function* streamChat(request: ChatRequest): AsyncGenerator<LLMStreamChunk> {
	const response = await api.chat.$post({ json: request });

	if (!response.ok || !response.body) {
		throw new Error(`Nightcode server chat failed: HTTP ${response.status}`);
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
