import { describe, expect, it } from "bun:test";
import {
	completeToolActivity,
	formatApprovalArgs,
	formatToolResultPreview,
	type ToolActivity,
} from "./tool-activity";

function pendingActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
	return {
		id: "tool-1",
		name: "shell",
		args: { command: "bun test" },
		status: "pending",
		startedAt: 1_000,
		...overrides,
	};
}

describe("tool activity completion", () => {
	it("marks an empty successful result as succeeded", () => {
		const completed = completeToolActivity(pendingActivity(), { result: "" }, 1_125);

		expect(completed.status).toBe("succeeded");
		expect(completed.result).toBe("");
		expect(completed.durationMs).toBe(125);
		expect(formatToolResultPreview(completed)).toBe("(no output)");
	});

	it("marks tool errors as failed and retains their output", () => {
		const completed = completeToolActivity(
			pendingActivity(),
			{ result: "command failed", isError: true },
			1_250,
		);

		expect(completed.status).toBe("failed");
		expect(completed.result).toBe("command failed");
		expect(completed.durationMs).toBe(250);
		expect(formatToolResultPreview(completed)).toBe("command failed");
	});
});

describe("tool activity previews", () => {
	it("hides pending output and compacts completed multiline output", () => {
		expect(formatToolResultPreview(pendingActivity())).toBe("");

		const completed = completeToolActivity(
			pendingActivity(),
			{ result: "first line\n\nsecond\tline" },
			1_100,
		);
		expect(formatToolResultPreview(completed)).toBe("first line second line");
	});

	it("truncates long previews with an ellipsis", () => {
		const completed = completeToolActivity(
			pendingActivity(),
			{ result: "abcdefghijklmnop" },
			1_100,
		);
		expect(formatToolResultPreview(completed, 5)).toBe("abcd\u2026");
	});

	it("formats approval arguments as a readable single line", () => {
		expect(formatApprovalArgs("shell", { command: "bun test\npackages/cli/src/services" })).toBe(
			"bun test packages/cli/src/services",
		);
		expect(
			formatApprovalArgs("applyPatch", {
				operations: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
			}),
		).toBe("2 operation(s): src/one.ts, src/two.ts");
		expect(formatApprovalArgs("unknown", {})).toBe("{}");
	});
});
