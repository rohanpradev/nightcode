import { rm } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteFile, sha256, type WorkspaceBoundary } from "./workspace-boundary";

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

	const occurrences = before.split(operation.oldText).length - 1;
	if (occurrences === 0) throw new Error(`oldText not found in ${operation.path}`);
	if (occurrences > 1) {
		throw new Error(`oldText matched ${occurrences} times in ${operation.path}; make it unique`);
	}
	return before.replace(operation.oldText, operation.newText);
}

async function restore(snapshots: PatchSnapshot[]): Promise<void> {
	for (const snapshot of [...snapshots].reverse()) {
		if (snapshot.before === null) {
			await rm(snapshot.path, { force: true }).catch(() => undefined);
		} else {
			await atomicWriteFile(snapshot.path, snapshot.before);
		}
	}
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
		if (!exists || sha256(await file.text()) !== sha256(snapshot.after)) {
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

	for (const operation of operations) {
		const authorized = await boundary.authorize(operation.path, "write");
		if (seen.has(authorized.canonicalPath)) {
			throw new Error(`Patch contains multiple operations for ${operation.path}`);
		}
		seen.add(authorized.canonicalPath);

		const before = authorized.exists ? await Bun.file(authorized.canonicalPath).text() : null;
		const after = applyOperation(operation, before);
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
		await restore(applied);
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

export async function restorePatch(snapshots: PatchSnapshot[]): Promise<void> {
	await verifyPatchIsCurrent(snapshots);
	await restore(snapshots);
}
