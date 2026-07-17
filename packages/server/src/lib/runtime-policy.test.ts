import { describe, expect, it } from "bun:test";
import { resolveRuntimePolicy } from "./runtime-policy";

describe("runtime policy", () => {
	it("allows repository policy to narrow but never weaken trusted defaults", () => {
		const policy = resolveRuntimePolicy(
			{
				approvalMode: "never",
				allowedPaths: ["C:\\"],
				requirePlanForEdits: false,
				maxAgentSteps: 100,
				disabledTools: ["updateTaskPlan", "shell"],
			},
			{ workspaceRoot: process.cwd(), env: {} },
		);

		expect(policy.approvalMode).toBe("on-risk");
		expect(policy.denyRiskyTools).toBe(true);
		expect(policy.allowedPaths).toEqual([]);
		expect(policy.requirePlanForEdits).toBe(true);
		expect(policy.maxAgentSteps).toBe(20);
		expect(policy.disabledTools).toEqual(new Set(["shell"]));
		expect(policy.diagnostics.join("\n")).toContain("adds hard denials");
	});

	it("honors explicit user-owned relaxations while project PLAN and limits still narrow", () => {
		const policy = resolveRuntimePolicy(
			{
				mode: "PLAN",
				approvalMode: "on-risk",
				requirePlanForEdits: false,
				maxAgentSteps: 12,
			},
			{
				workspaceRoot: process.cwd(),
				env: {
					NIGHTCODE_APPROVAL_MODE: "never",
					NIGHTCODE_REQUIRE_PLAN_FOR_EDITS: "false",
					NIGHTCODE_MAX_AGENT_STEPS: "40",
				},
			},
		);

		expect(policy.mode).toBe("PLAN");
		expect(policy.approvalMode).toBe("on-risk");
		expect(policy.denyRiskyTools).toBe(true);
		expect(policy.requirePlanForEdits).toBe(false);
		expect(policy.maxAgentSteps).toBe(12);
	});

	it("combines project-wide prompting with trusted hard-deny semantics", () => {
		const policy = resolveRuntimePolicy(
			{ approvalMode: "always" },
			{
				workspaceRoot: process.cwd(),
				env: { NIGHTCODE_APPROVAL_MODE: "never" },
			},
		);

		expect(policy.approvalMode).toBe("always");
		expect(policy.denyRiskyTools).toBe(true);
	});
});
