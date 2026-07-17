import { describe, expect, it } from "bun:test";
import { WorkspaceMutationCoordinator } from "./mutation-coordinator";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("WorkspaceMutationCoordinator", () => {
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
