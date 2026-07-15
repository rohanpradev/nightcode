import { describe, expect, test } from "bun:test";
import { evaluateCoverage, parseLcovTotals } from "./check-coverage";

describe("coverage gate", () => {
	test("aggregates LCOV records", () => {
		expect(
			parseLcovTotals(
				["TN:", "SF:a.ts", "FNF:4", "FNH:3", "LF:10", "LH:8", "end_of_record"].join("\n"),
			),
		).toEqual({ functionsFound: 4, functionsHit: 3, linesFound: 10, linesHit: 8 });
	});

	test("reports metrics below the source-only floor", () => {
		expect(
			evaluateCoverage(
				{
					functionsFound: 10,
					functionsHit: 5,
					linesFound: 10,
					linesHit: 8,
				},
				() => {},
			),
		).toEqual(["functions"]);
	});
});
