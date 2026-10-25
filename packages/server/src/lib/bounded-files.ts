import { createReadStream } from "node:fs";

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
	const input = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
	const abort = () =>
		input.destroy(
			abortSignal?.reason instanceof Error ? abortSignal.reason : new Error("file read aborted"),
		);
	abortSignal?.addEventListener("abort", abort, { once: true });
	if (abortSignal?.aborted) abort();
	const output: string[] = [];
	let lineNumber = 1;
	let line = "";
	let hasContent = false;
	let skipLineFeed = false;
	let chars = 0;
	let truncated = false;
	let reading = true;

	// Buffer only the requested line's remaining allowance. In particular,
	// readline would accumulate an entire minified line before enforcing the cap.
	const append = (part: string): boolean => {
		hasContent = true;
		if (lineNumber < startLine) return true;
		const prefix = `${lineNumber}: `;
		const available = maxChars - chars - prefix.length - 1;
		if (line.length + part.length > available) {
			if (available > 0) {
				const partial = (line + part.slice(0, available - line.length)).replace(
					/[\uD800-\uDBFF]$/,
					"",
				);
				if (partial) output.push(prefix + partial);
			}
			truncated = true;
			return false;
		}
		line += part;
		return true;
	};

	const finishLine = (): boolean => {
		if (lineNumber >= startLine) {
			const rendered = `${lineNumber}: ${line}`;
			if (chars + rendered.length + 1 > maxChars) {
				truncated = true;
				return false;
			}
			output.push(rendered);
			chars += rendered.length + 1;
		}
		line = "";
		hasContent = false;
		lineNumber++;
		return lineNumber <= endLine;
	};

	try {
		for await (const chunk of input) {
			if (abortSignal?.aborted) throw abortSignal.reason ?? new Error("file read aborted");
			let offset = 0;
			if (skipLineFeed) {
				skipLineFeed = false;
				if (chunk.charCodeAt(0) === 10) offset = 1;
			}
			while (offset < chunk.length) {
				let end = offset;
				while (end < chunk.length && chunk.charCodeAt(end) !== 10 && chunk.charCodeAt(end) !== 13)
					end++;
				if (end > offset && !append(chunk.slice(offset, end))) {
					reading = false;
					break;
				}
				if (end === chunk.length) break;
				if (!finishLine()) {
					reading = false;
					break;
				}
				offset = end + 1;
				if (chunk.charCodeAt(end) === 13) {
					if (offset === chunk.length) skipLineFeed = true;
					else if (chunk.charCodeAt(offset) === 10) offset++;
				}
			}
			if (!reading) break;
		}
		if (abortSignal?.aborted) throw abortSignal.reason ?? new Error("file read aborted");
		if (reading && hasContent) finishLine();
	} catch (error) {
		if (abortSignal?.aborted) throw abortSignal.reason ?? error;
		throw error;
	} finally {
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
