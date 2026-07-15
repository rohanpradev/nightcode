import { COMMANDS } from "@cli/components/command-menu/commands";
import {
	expandHomePath,
	parseSlashCommand,
	resolveUserPath,
	stripEnclosingQuotes,
} from "@cli/slash-commands";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("slash command metadata", () => {
	test("command names and values are unique and aligned", () => {
		const names = COMMANDS.map((command) => command.name);
		const values = COMMANDS.map((command) => command.value);

		expect(new Set(names).size).toBe(names.length);
		expect(new Set(values).size).toBe(values.length);
		for (const command of COMMANDS) {
			expect(command.value).toBe(`/${command.name}`);
			if (command.inputTemplate) expect(command.inputTemplate).toStartWith(`${command.value} `);
		}
	});
});

describe("slash command parsing", () => {
	test("normalizes command names while preserving the full argument", () => {
		expect(parseSlashCommand('  /WORKSPACE "C:\\Code Projects\\nightcode"  ')).toEqual({
			name: "workspace",
			arg: '"C:\\Code Projects\\nightcode"',
			raw: '/WORKSPACE "C:\\Code Projects\\nightcode"',
		});
	});

	test("does not treat ordinary prompts as commands", () => {
		expect(parseSlashCommand("explain /workspace to me")).toBeNull();
	});

	test("strips only matching enclosing quotes", () => {
		expect(stripEnclosingQuotes('"a b"')).toBe("a b");
		expect(stripEnclosingQuotes("'a b'")).toBe("a b");
		expect(stripEnclosingQuotes("\"a b'")).toBe("\"a b'");
	});

	test("expands home paths and resolves relative paths", () => {
		const home = process.env.HOME ?? process.env.USERPROFILE;
		if (home) expect(expandHomePath("~/project")).toBe(`${home}/project`);
		expect(resolveUserPath("./packages")).toBe(resolve("packages"));
	});
});
