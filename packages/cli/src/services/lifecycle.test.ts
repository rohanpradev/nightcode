import { describe, expect, test } from "bun:test";

async function exitInChild(setup: string) {
	const lifecycleUrl = new URL("./lifecycle.ts", import.meta.url).href;
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"--eval",
			`import { gracefulExit, setBeforeExit, setRenderer } from ${JSON.stringify(lifecycleUrl)};
${setup}
await gracefulExit();`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

describe("graceful terminal shutdown", () => {
	test("saves the session and waits for asynchronous terminal restoration before exiting", async () => {
		const result = await exitInChild(`
setBeforeExit(async () => { console.log("saved"); });
setRenderer({
  destroy() { console.log("destroyed"); },
  get closed() {
    return new Promise(resolve => setTimeout(() => {
      console.log("terminal restored");
      resolve();
    }, 30));
  },
});`);
		expect(result.code).toBe(0);
		expect(result.stdout.trim().split(/\r?\n/)).toEqual([
			"saved",
			"destroyed",
			"terminal restored",
		]);
		expect(result.stderr).toBe("");
	});

	test("reports terminal restoration failures with a failing exit status", async () => {
		const result = await exitInChild(`
setRenderer({
  destroy() {},
  get closed() { return Promise.reject(new Error("output closed")); },
});`);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Nightcode could not restore the terminal: output closed");
	});

	test("still restores the terminal if saving the session fails", async () => {
		const result = await exitInChild(`
setBeforeExit(async () => { throw new Error("disk full"); });
setRenderer({
  destroy() { console.log("destroyed"); },
  get closed() { return Promise.resolve().then(() => console.log("terminal restored")); },
});`);
		expect(result.code).toBe(1);
		expect(result.stdout.trim().split(/\r?\n/)).toEqual(["destroyed", "terminal restored"]);
		expect(result.stderr).toContain("Nightcode could not save the active session: disk full");
	});
});
