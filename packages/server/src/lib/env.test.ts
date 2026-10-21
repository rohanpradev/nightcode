import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { trustedEnvPaths } from "./env";

describe("trusted environment loading", () => {
	it.each([false, true])(
		"preserves trusted paths, parent precedence, and quiet loading (explicit file: %s)",
		async (explicitFile) => {
			const fixture = await mkdtemp(join(tmpdir(), "nightcode-env-"));
			try {
				const home = join(fixture, "home");
				const workspace = join(fixture, "workspace");
				await mkdir(join(home, ".nightcode"), { recursive: true });
				await mkdir(workspace);
				const trustedFile = explicitFile
					? join(fixture, "trusted.env")
					: join(home, ".nightcode", ".env");
				await writeFile(
					trustedFile,
					'NIGHTCODE_TEST_VALUE="trusted # value"\nNIGHTCODE_TEST_PRECEDENCE=file\n',
				);
				await writeFile(join(workspace, ".env"), "NIGHTCODE_TEST_VALUE=workspace\n");
				const envUrl = pathToFileURL(resolve(import.meta.dir, "env.ts")).href;
				const result = Bun.spawnSync(
					[
						process.execPath,
						"--no-env-file",
						"-e",
						`await import(${JSON.stringify(envUrl)}); console.log(JSON.stringify({ value: process.env.NIGHTCODE_TEST_VALUE, precedence: process.env.NIGHTCODE_TEST_PRECEDENCE }));`,
					],
					{
						cwd: workspace,
						env: {
							...process.env,
							NIGHTCODE_HOME: home,
							NIGHTCODE_ENV_FILE: explicitFile ? trustedFile : "",
							NIGHTCODE_TEST_VALUE: undefined,
							NIGHTCODE_TEST_PRECEDENCE: "parent",
							DOTENV_PATH: join(workspace, ".env"),
							DOTENV_OVERRIDE: "true",
							DOTENV_DEBUG: "true",
							DOTENV_QUIET: "false",
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				expect(result.exitCode).toBe(0);
				expect(result.stderr.toString()).toBe("");
				expect(JSON.parse(result.stdout.toString())).toEqual({
					value: "trusted # value",
					precedence: "parent",
				});
			} finally {
				await rm(fixture, { recursive: true, force: true });
			}
		},
	);

	it("accepts blank optional provider URLs without import-time crashes", () => {
		const routerUrl = pathToFileURL(resolve(import.meta.dir, "../services/model-router.ts")).href;
		const result = Bun.spawnSync(
			[process.execPath, "--no-env-file", "-e", `await import(${JSON.stringify(routerUrl)});`],
			{
				env: {
					...process.env,
					OPENAI_BASE_URL: "",
					ANTHROPIC_BASE_URL: "  ",
					AZURE_BASE_URL: "",
					AZURE_OPENAI_BASE_URL: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
	});

	it("uses only the user-owned env file, never the workspace or install directory", () => {
		const paths = trustedEnvPaths({ home: "C:\\user" });
		expect(paths).toEqual([resolve("C:\\user", ".nightcode", ".env")]);
		expect(paths).not.toContain(resolve(process.cwd(), ".env"));
	});

	it("honors one explicit trusted env file", () => {
		expect(
			trustedEnvPaths({
				home: "C:\\user",
				explicitPath: "C:\\config\\nightcode.env",
			}),
		).toEqual([resolve("C:\\config\\nightcode.env")]);
	});
});
