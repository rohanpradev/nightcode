import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeManager, RuntimeSessionError } from "./runtime-manager";

describe("RuntimeManager", () => {
	it("isolates session services and pins each session to one workspace", async () => {
		const first = await mkdtemp(join(tmpdir(), "nightcode-runtime-a-"));
		const second = await mkdtemp(join(tmpdir(), "nightcode-runtime-b-"));
		const manager = new RuntimeManager();

		const a = manager.getOrCreate("a", first);
		expect(manager.getOrCreate("a", first)).toBe(a);
		expect(manager.getOrCreate("b", first)).not.toBe(a);
		expect(() => manager.getOrCreate("a", second)).toThrow(RuntimeSessionError);
	});

	it("prunes idle sessions without unbounded process state", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nightcode-runtime-"));
		const manager = new RuntimeManager({ idleTtlMs: 1 });
		manager.getOrCreate("old", workspace);
		expect(manager.prune(Date.now() + 10)).toBe(1);
		expect(manager.list()).toHaveLength(0);
	});
});
