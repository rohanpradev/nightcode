type CoverageTotals = {
	functionsFound: number;
	functionsHit: number;
	linesFound: number;
	linesHit: number;
};

const thresholds = {
	functions: 0.55,
	lines: 0.65,
} as const;

export function parseLcovTotals(lcov: string): CoverageTotals {
	const totals: CoverageTotals = {
		functionsFound: 0,
		functionsHit: 0,
		linesFound: 0,
		linesHit: 0,
	};

	for (const line of lcov.split(/\r?\n/)) {
		const [key, rawValue] = line.split(":", 2);
		const value = Number(rawValue);
		if (!Number.isSafeInteger(value) || value < 0) continue;

		switch (key) {
			case "FNF":
				totals.functionsFound += value;
				break;
			case "FNH":
				totals.functionsHit += value;
				break;
			case "LF":
				totals.linesFound += value;
				break;
			case "LH":
				totals.linesHit += value;
				break;
		}
	}

	return totals;
}

function ratio(hit: number, found: number): number {
	return found === 0 ? 1 : hit / found;
}

function percentage(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

export function evaluateCoverage(
	totals: CoverageTotals,
	log: (message: string) => void = console.log,
): string[] {
	const results = [
		{
			label: "lines",
			actual: ratio(totals.linesHit, totals.linesFound),
			required: thresholds.lines,
		},
		{
			label: "functions",
			actual: ratio(totals.functionsHit, totals.functionsFound),
			required: thresholds.functions,
		},
	];

	const failures: string[] = [];
	for (const result of results) {
		log(
			`Weighted coverage ${result.label}: ${percentage(result.actual)} (required ${percentage(result.required)})`,
		);
		if (result.actual < result.required) failures.push(result.label);
	}
	return failures;
}

if (import.meta.main) {
	const coverageFile = Bun.file(new URL("../coverage/lcov.info", import.meta.url));
	if (!(await coverageFile.exists())) {
		throw new Error(
			"coverage/lcov.info does not exist; run Bun tests with the LCOV reporter first",
		);
	}

	const failures = evaluateCoverage(parseLcovTotals(await coverageFile.text()));
	if (failures.length > 0) {
		throw new Error(`Coverage threshold failed for: ${failures.join(", ")}`);
	}
}
