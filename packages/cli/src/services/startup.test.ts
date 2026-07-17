import { describe, expect, it } from "bun:test";
import { requestedWorkspace, validateCliArguments } from "./startup";

describe("CLI argument validation", () => {
	it("accepts documented flags and equals syntax", () => {
		expect(() =>
			validateCliArguments(["--workspace=C:\\code\\project", "--continue"]),
		).not.toThrow();
		expect(() => validateCliArguments(["resume", "session-prefix"])).not.toThrow();
		expect(requestedWorkspace(["-w=C:\\code\\project"])).toBe("C:\\code\\project");
	});

	it("rejects unknown options and missing values", () => {
		expect(() => validateCliArguments(["--wat"])).toThrow("Unknown option");
		expect(() => validateCliArguments(["--workspace"])).toThrow("Missing value");
		expect(() => validateCliArguments(["--resume", "--json"])).toThrow("Missing value");
	});
});
