import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig } from "./config-loader";

async function createProject(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "nightcode-config-"));
	const configDir = join(root, ".nightcode");
	await mkdir(configDir, { recursive: true });

	for (const [name, content] of Object.entries(files)) {
		await writeFile(join(configDir, name), content);
	}

	return root;
}

describe("project config loader", () => {
	it("parses and validates supported flat YAML config values", async () => {
		const root = await createProject({
			"config.yaml": [
				'model: "gpt-5-mini"',
				"mode: PLAN",
				"maxTokens: 4096",
				"temperature: 0.5",
				'allowedPaths: ["../shared", "./tools"]',
				"disabledTools: []",
				"requirePlanForEdits: false",
			].join("\n"),
		});

		expect(loadProjectConfig(root).config).toEqual({
			model: "gpt-5-mini",
			mode: "PLAN",
			maxTokens: 4096,
			temperature: 0.5,
			allowedPaths: ["../shared", "./tools"],
			disabledTools: [],
			requirePlanForEdits: false,
		});
	});

	it("falls back to an empty config when YAML values fail validation", async () => {
		const root = await createProject({
			"config.yaml": ["temperature: 10", "allowedPaths: true"].join("\n"),
		});

		expect(loadProjectConfig(root).config).toEqual({});
	});

	it("accepts wrapped MCP server config and rejects invalid server entries", async () => {
		const validRoot = await createProject({
			"mcp.json": JSON.stringify({
				servers: {
					local: {
						transport: "stdio",
						command: "bun",
						args: ["run", "mcp"],
						env: { FOO: "bar" },
					},
				},
			}),
		});
		expect(loadProjectConfig(validRoot).mcpServers).toEqual({
			local: {
				transport: "stdio",
				command: "bun",
				args: ["run", "mcp"],
				env: { FOO: "bar" },
				requireApproval: true,
			},
		});

		const invalidRoot = await createProject({
			"mcp.json": JSON.stringify({ local: { transport: "bogus" } }),
		});
		const invalid = loadProjectConfig(invalidRoot);
		expect(invalid.mcpServers).toBeNull();
		expect(invalid.diagnostics).toHaveLength(1);
		expect(invalid.diagnostics[0]).toMatchObject({ severity: "error" });
		expect(invalid.diagnostics[0]?.file).toMatch(/[\\/]\.nightcode[\\/]mcp\.json$/);
	});

	it("does not load instruction directories that escape through a link", async () => {
		const root = await createProject({});
		const outside = await mkdtemp(join(tmpdir(), "nightcode-config-outside-"));
		await writeFile(join(outside, "leak.instructions.md"), "host-secret-marker");
		await mkdir(join(root, ".github"), { recursive: true });
		try {
			await symlink(outside, join(root, ".github", "instructions"), "junction");
		} catch {
			return;
		}

		const loaded = loadProjectConfig(root);
		expect(loaded.instructions).toBeNull();
		expect(loaded.diagnostics.some((item) => item.message.includes("escapes"))).toBe(true);
	});
});
