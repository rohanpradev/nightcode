import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceMutationCoordinator } from "./mutation-coordinator";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("WorkspaceMutationCoordinator", () => {
	it.each([
		["nested workspace", ["workspace"], ["workspace/child"]],
		["parent workspace", ["workspace/child"], ["workspace"]],
		["shared external root", ["one", "shared"], ["two", "shared"]],
		["nested external root", ["one", "shared"], ["two", "shared/child"]],
		["reversed root order", ["one", "two"], ["two", "one"]],
	] as const)("serializes %s mutations", async (_name, firstRoots, secondRoots) => {
		const coordinator = new WorkspaceMutationCoordinator();
		const gate = deferred();
		const started = deferred();
		const events: string[] = [];
		const first = coordinator.run(firstRoots, async () => {
			events.push("first:start");
			started.resolve();
			await gate.promise;
			events.push("first:end");
		});
		const second = coordinator.run(secondRoots, async () => {
			events.push("second");
		});
		try {
			await started.promise;
			await Bun.sleep(0);
			expect(events).toEqual(["first:start"]);
		} finally {
			gate.resolve();
			await Promise.all([first, second]);
		}
		expect(events).toEqual(["first:start", "first:end", "second"]);
	});

	it("allows disjoint sibling roots to run concurrently", async () => {
		const coordinator = new WorkspaceMutationCoordinator();
		const gate = deferred();
		const started = deferred();
		const first = coordinator.run("workspace", async () => {
			started.resolve();
			await gate.promise;
		});
		let secondRan = false;
		const second = coordinator.run("workspace-other", async () => {
			secondRan = true;
		});
		try {
			await started.promise;
			await Bun.sleep(0);
			expect(secondRan).toBe(true);
		} finally {
			gate.resolve();
			await Promise.all([first, second]);
		}
	});

	it("canonicalizes missing roots below directory aliases", async () => {
		const directory = await mkdtemp(join(tmpdir(), "nightcode-lock-alias-"));
		const target = join(directory, "target");
		const alias = join(directory, "alias");
		const gate = deferred();
		let first: Promise<void> | undefined;
		let second: Promise<void> | undefined;
		try {
			await mkdir(target);
			await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
			const coordinator = new WorkspaceMutationCoordinator();
			first = coordinator.run(join(target, "missing"), () => gate.promise);
			let secondRan = false;
			second = coordinator.run(join(alias, "missing"), async () => {
				secondRan = true;
			});
			await Bun.sleep(0);
			expect(secondRan).toBe(false);
		} finally {
			gate.resolve();
			await Promise.all([first, second]);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("releases all reserved roots after a failed operation", async () => {
		const coordinator = new WorkspaceMutationCoordinator();
		const failed = coordinator.run(["one", "shared"], async () => {
			throw new Error("write failed");
		});
		const next = coordinator.run(["two", "shared"], async () => "recovered");
		await expect(failed).rejects.toThrow("write failed");
		expect(await next).toBe("recovered");
	});

	it("keeps overlapping FIFO reservations intact when a bridging waiter aborts", async () => {
		const coordinator = new WorkspaceMutationCoordinator();
		const gate = deferred();
		const controller = new AbortController();
		const first = coordinator.run("one", () => gate.promise);
		const bridge = coordinator.run(["one", "two"], async () => {}, controller.signal);
		let lastRan = false;
		const last = coordinator.run("two", async () => {
			lastRan = true;
		});
		try {
			controller.abort();
			await expect(bridge).rejects.toMatchObject({ name: "AbortError" });
			await Bun.sleep(0);
			expect(lastRan).toBe(false);
		} finally {
			gate.resolve();
			await Promise.all([first, last]);
		}
		expect(lastRan).toBe(true);
	});

	it("runs same-workspace mutations in FIFO order", async () => {
		const coordinator = new WorkspaceMutationCoordinator();
		const gate = deferred();
		const started = deferred();
		const events: string[] = [];
		const first = coordinator.run("C:/workspace", async () => {
			events.push("first:start");
			started.resolve();
			await gate.promise;
			events.push("first:end");
		});
		const second = coordinator.run("C:/workspace", async () => {
			events.push("second:start");
		});

		await started.promise;
		expect(events).toEqual(["first:start"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("removes an aborted waiter without blocking later mutations", async () => {
		const coordinator = new WorkspaceMutationCoordinator();
		const gate = deferred();
		const started = deferred();
		const controller = new AbortController();
		const events: string[] = [];
		const first = coordinator.run("C:/workspace", async () => {
			events.push("first");
			started.resolve();
			await gate.promise;
		});
		const aborted = coordinator.run(
			"C:/workspace",
			async () => {
				events.push("aborted");
			},
			controller.signal,
		);
		const third = coordinator.run("C:/workspace", async () => {
			events.push("third");
		});

		await started.promise;
		controller.abort("cancel queued mutation");
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		gate.resolve();
		await Promise.all([first, third]);
		expect(events).toEqual(["first", "third"]);
	});
});
