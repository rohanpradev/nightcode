import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, loadSkill } from "./skills";

const roots: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "nightcode-skills-"));
	roots.push(root);
	process.env.HOME = root;
	return root;
}

function skill(root: string, directory: string, content: string): void {
	const path = join(root, directory, "skills", "example");
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "SKILL.md"), content);
}

describe("skill discovery", () => {
	it("keeps every skill when multiple roots contain the same name", () => {
		const root = fixture();
		for (const directory of [".nightcode", ".agents", ".github"]) {
			skill(root, directory, `# ${directory}\nDescription`);
		}
		const project = discoverSkills(root).filter((item) => item.scope === "project");
		expect(project.map((item) => item.id)).toEqual([
			"example",
			"example-project",
			"example-project-2",
		]);
		expect(loadSkill("example-project-2", root)).toContain("# .github");
	});

	it("bounds oversized global skill reads while retaining their metadata", () => {
		const root = fixture();
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		skill(root, ".nightcode", `# Large\ndescription: example\n${"x".repeat(100_000)}`);
		const found = discoverSkills(workspace);
		expect(found).toHaveLength(1);
		expect(found[0]?.name).toBe("Large");
		expect(loadSkill("example", workspace).length).toBeLessThan(80_100);
	});
});
