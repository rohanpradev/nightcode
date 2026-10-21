import { rm, stat } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteFile, sha256, type WorkspaceBoundary } from "./workspace-boundary";

export const MAX_PATCH_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_BATCH_BYTES = 32 * 1024 * 1024;

/** Read a reversible text snapshot without decoding invalid bytes lossily. */
export async function readPatchText(path: string): Promise<string> {
	if (!(await stat(path)).isFile()) throw new Error(`Not a regular file: ${path}`);
	const bytes = await Bun.file(path)
		.slice(0, MAX_PATCH_FILE_BYTES + 1)
		.bytes();
	if (bytes.byteLength > MAX_PATCH_FILE_BYTES) {
		throw new Error(`Text patch file exceeds 8 MiB: ${path}`);
	}
	try {
		// Preserve a UTF-8 BOM in hashes, replacements, and undo snapshots.
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		if (text.includes("\0")) throw new Error("binary data");
		return text;
	} catch {
		throw new Error(`Text patches require UTF-8 text without NUL bytes: ${path}`);
	}
}

export function replaceUniqueText(
	before: string,
	oldText: string,
	newText: string,
	path: string,
): string {
	if (!oldText) throw new Error(`oldText must not be empty in ${path}`);
	const index = before.indexOf(oldText);
	if (index < 0) throw new Error(`oldText not found in ${path}`);
	if (before.indexOf(oldText, index + 1) >= 0) {
		throw new Error(`oldText matched multiple times in ${path}; make it unique`);
	}
	return before.slice(0, index) + newText + before.slice(index + oldText.length);
}

const expectedHashSchema = z
	.string()
	.regex(/^[a-f0-9]{64}$/i)
	.optional();

export const patchOperationSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("create"), path: z.string().min(1), content: z.string() }),
	z.object({
		type: z.literal("update"),
		path: z.string().min(1),
		content: z.string(),
		expectedSha256: expectedHashSchema,
	}),
	z.object({
		type: z.literal("replace"),
		path: z.string().min(1),
		oldText: z.string().min(1),
		newText: z.string(),
		expectedSha256: expectedHashSchema,
	}),
	z.object({
		type: z.literal("delete"),
		path: z.string().min(1),
		expectedSha256: expectedHashSchema,
	}),
]);

export const structuredPatchSchema = z.object({
	operations: z.array(patchOperationSchema).min(1).max(100),
});

export type PatchOperation = z.infer<typeof patchOperationSchema>;

export interface PatchSnapshot {
	path: string;
	before: string | null;
	after: string | null;
}

export interface PatchResult {
	summary: string;
	snapshots: PatchSnapshot[];
}

function applyOperation(operation: PatchOperation, before: string | null): string | null {
	if (operation.type === "create") {
		if (before !== null) throw new Error(`Cannot create existing file: ${operation.path}`);
		return operation.content;
	}
	if (before === null) throw new Error(`File not found: ${operation.path}`);

	if (operation.expectedSha256 && sha256(before) !== operation.expectedSha256.toLowerCase()) {
		throw new Error(`Content changed since inspection: ${operation.path}`);
	}
	if (operation.type === "delete") return null;
	if (operation.type === "update") return operation.content;

	return replaceUniqueText(before, operation.oldText, operation.newText, operation.path);
}

async function restore(snapshots: PatchSnapshot[]): Promise<void> {
	const errors: Error[] = [];
	for (const snapshot of [...snapshots].reverse()) {
		try {
			if (snapshot.before === null) {
				await rm(snapshot.path, { force: true });
			} else {
				await atomicWriteFile(snapshot.path, snapshot.before);
			}
		} catch (error) {
			errors.push(new Error(`Could not roll back ${snapshot.path}`, { cause: error }));
		}
	}
	if (errors.length)
		throw new AggregateError(errors, errors.map((error) => error.message).join("\n"));
}

async function verifyPatchIsCurrent(snapshots: PatchSnapshot[]): Promise<void> {
	const conflicts: string[] = [];
	for (const snapshot of snapshots) {
		const file = Bun.file(snapshot.path);
		const exists = await file.exists();
		if (snapshot.after === null) {
			if (exists) conflicts.push(snapshot.path);
			continue;
		}
		if (!exists || sha256(await readPatchText(snapshot.path)) !== sha256(snapshot.after)) {
			conflicts.push(snapshot.path);
		}
	}
	if (conflicts.length > 0) {
		throw new Error(
			`Undo stopped because ${conflicts.length} patched file(s) changed afterward:\n${conflicts.join("\n")}`,
		);
	}
}

/** Validate every operation before mutating, then roll back the complete batch on failure. */
export async function applyStructuredPatch(
	boundary: WorkspaceBoundary,
	operations: PatchOperation[],
): Promise<PatchResult> {
	const snapshots: PatchSnapshot[] = [];
	const seen = new Set<string>();
	let batchBytes = 0;

	for (const operation of structuredPatchSchema.parse({ operations }).operations) {
		const authorized = await boundary.authorize(operation.path, "write");
		const key =
			process.platform === "win32"
				? authorized.canonicalPath.toLowerCase()
				: authorized.canonicalPath;
		if (seen.has(key)) {
			throw new Error(`Patch contains multiple operations for ${operation.path}`);
		}
		seen.add(key);

		const before = authorized.exists ? await readPatchText(authorized.canonicalPath) : null;
		const after = applyOperation(operation, before);
		const afterBytes = after === null ? 0 : Buffer.byteLength(after, "utf8");
		if (
			afterBytes > MAX_PATCH_FILE_BYTES ||
			after?.includes("\0") ||
			(after !== null && !after.isWellFormed())
		) {
			throw new Error(
				`Text patch output must be valid Unicode, at most 8 MiB, without NUL bytes: ${operation.path}`,
			);
		}
		batchBytes += Buffer.byteLength(before ?? "", "utf8") + afterBytes;
		if (batchBytes > MAX_PATCH_BATCH_BYTES) throw new Error("Text patch batch exceeds 32 MiB");
		snapshots.push({ path: authorized.canonicalPath, before, after });
	}

	const applied: PatchSnapshot[] = [];
	try {
		for (const snapshot of snapshots) {
			if (snapshot.after === null) {
				await rm(snapshot.path);
			} else {
				await atomicWriteFile(snapshot.path, snapshot.after);
			}
			applied.push(snapshot);
		}
	} catch (error) {
		try {
			await restore(applied);
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				`Patch failed and rollback was incomplete: ${String(rollbackError)}`,
				{ cause: error },
			);
		}
		throw error;
	}

	const created = snapshots.filter((item) => item.before === null).length;
	const deleted = snapshots.filter((item) => item.after === null).length;
	const updated = snapshots.length - created - deleted;
	return {
		summary: `applied ${snapshots.length} operation(s): ${created} created, ${updated} updated, ${deleted} deleted`,
		snapshots,
	};
}

export async function restorePatch(
	snapshots: PatchSnapshot[],
	boundary: WorkspaceBoundary,
): Promise<void> {
	for (const snapshot of snapshots) {
		const authorized = await boundary.authorize(snapshot.path, "write");
		if (authorized.canonicalPath !== snapshot.path) {
			throw new Error(`Undo stopped because a patched path was redirected: ${snapshot.path}`);
		}
	}
	await verifyPatchIsCurrent(snapshots);
	// Undo uses the same preflight and rollback guarantees as a forward patch.
	await applyStructuredPatch(
		boundary,
		[...snapshots].reverse().map((snapshot): PatchOperation => {
			if (snapshot.after === null) {
				return { type: "create", path: snapshot.path, content: snapshot.before ?? "" };
			}
			const expectedSha256 = sha256(snapshot.after);
			return snapshot.before === null
				? { type: "delete", path: snapshot.path, expectedSha256 }
				: { type: "update", path: snapshot.path, content: snapshot.before, expectedSha256 };
		}),
	);
}
