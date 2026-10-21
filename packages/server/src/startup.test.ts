import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const serverDirectory = resolve(import.meta.dir, "..");

function launchServer(port: number, watch: boolean) {
	const child = Bun.spawn(
		[process.execPath, ...(watch ? ["--watch"] : []), "run", "src/index.ts"],
		{
			cwd: serverDirectory,
			env: {
				...process.env,
				PORT: String(port),
				NIGHTCODE_HOST: "127.0.0.1",
				NIGHTCODE_API_TOKEN: "",
				NIGHTCODE_LOG_LEVEL: "info",
				// Keep developer credentials/configuration out of startup tests.
				NIGHTCODE_ENV_FILE: resolve(serverDirectory, "missing-startup-test.env"),
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let output = "";
	async function collect(stream: ReadableStream<Uint8Array>) {
		const decoder = new TextDecoder();
		for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
		output += decoder.decode();
	}
	const collected = Promise.all([collect(child.stdout), collect(child.stderr)]);
	const timeout = setTimeout(() => child.kill(), 8000);
	return {
		child,
		output: () => output,
		async stop() {
			clearTimeout(timeout);
			child.kill();
			await child.exited;
			await collected;
		},
	};
}

describe("server process startup", () => {
	it.each([false, true])(
		"serves health without binding twice (watch: %s)",
		async (watch) => {
			const reservation = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => new Response("reserved"),
			});
			const port = reservation.port;
			if (!port) throw new Error("Expected an assigned TCP port");
			await reservation.stop(true);
			const server = launchServer(port, watch);
			try {
				const deadline = Date.now() + 5000;
				while (!server.output().includes("server listening") && Date.now() < deadline) {
					if (server.child.exitCode !== null) break;
					await Bun.sleep(20);
				}
				// Bun inspects the default export after the entrypoint finishes evaluating.
				// A successful listen log alone misses a second, automatic server startup.
				await Bun.sleep(250);
				expect(server.output()).toContain(`server listening on http://127.0.0.1:${port}`);
				expect(server.output()).not.toContain("EADDRINUSE");
				expect(server.child.exitCode).toBeNull();
				const response = await fetch(`http://127.0.0.1:${port}/health`, {
					signal: AbortSignal.timeout(2000),
				});
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ ok: true, activeSessions: 0 });
			} finally {
				await server.stop();
			}
		},
		10000,
	);

	it("fails without taking over an occupied port", async () => {
		const existing = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("existing service"),
		});
		const port = existing.port;
		if (!port) throw new Error("Expected an assigned TCP port");
		const server = launchServer(port, false);
		try {
			expect(await server.child.exited).not.toBe(0);
			await server.stop();
			expect(server.output()).toContain("EADDRINUSE");
			expect(server.output()).not.toContain("server listening");
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			expect(await response.text()).toBe("existing service");
		} finally {
			await server.stop();
			await existing.stop(true);
		}
	}, 10000);
});
