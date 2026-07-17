import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { trustedEnvPaths } from "./env";

describe("trusted environment loading", () => {
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
