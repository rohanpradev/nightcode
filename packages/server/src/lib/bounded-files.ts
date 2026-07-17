import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function readTextPrefix(path: string, maxChars: number): Promise<string> {
	const file = Bun.file(path);
	const maxBytes = Math.min(file.size, maxChars * 4 + 4);
	const text = await file.slice(0, maxBytes).text();
	if (text.length <= maxChars && maxBytes >= file.size) return text;
	const prefix = text.slice(0, maxChars);
	return `${prefix}\n\n[truncated; file is ${file.size.toLocaleString()} bytes]`;
}

export async function readLineRange(
	path: string,
	startLine: number,
	endLine: number,
	maxChars: number,
	abortSignal?: AbortSignal,
): Promise<string> {
	if (abortSignal?.aborted) throw abortSignal.reason ?? new Error("file read aborted");
	const input = createReadStream(path, { encoding: "utf8" });
	const abort = () => input.destroy(abortSignal?.reason ?? new Error("file read aborted"));
	abortSignal?.addEventListener("abort", abort, { once: true });
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	const output: string[] = [];
	let lineNumber = 0;
	let chars = 0;
	let truncated = false;

	try {
		for await (const line of lines) {
			lineNumber++;
			if (lineNumber < startLine) continue;
			if (lineNumber > endLine) break;
			const rendered = `${lineNumber}: ${line}`;
			if (chars + rendered.length + 1 > maxChars) {
				truncated = true;
				break;
			}
			output.push(rendered);
			chars += rendered.length + 1;
		}
	} finally {
		lines.close();
		input.destroy();
		abortSignal?.removeEventListener("abort", abort);
	}

	if (truncated) output.push(`[truncated at ${maxChars.toLocaleString()} characters]`);
	return output.join("\n");
}

export async function sha256File(path: string, abortSignal?: AbortSignal): Promise<string> {
	if (abortSignal?.aborted) throw abortSignal.reason ?? new Error("file hash aborted");
	const hasher = new Bun.CryptoHasher("sha256");
	const reader = Bun.file(path).stream().getReader();
	try {
		while (true) {
			if (abortSignal?.aborted) throw abortSignal.reason ?? new Error("file hash aborted");
			const { done, value } = await reader.read();
			if (done) break;
			hasher.update(value);
		}
	} finally {
		reader.releaseLock();
	}
	return hasher.digest("hex");
}
