import { delimiter, isAbsolute, resolve } from "node:path";
import type { ApprovalMode } from "@nightcode/shared";
import type { NightcodeConfig } from "./config-loader";

const APPROVAL_STRENGTH: Record<ApprovalMode, number> = {
	never: 0,
	"on-risk": 1,
	always: 2,
};

export interface RuntimePolicy {
	mode: "BUILD" | "PLAN";
	approvalMode: ApprovalMode;
	/** Preserve non-interactive hard denials independently from prompt frequency. */
	denyRiskyTools: boolean;
	maxTokens: number;
	maxRetries: number;
	maxAgentSteps: number;
	maxToolOutputChars: number;
	maxToolTimeoutMs: number;
	maxRunDurationMs: number;
	contextBudget: number;
	requirePlanForEdits: boolean;
	allowedPaths: string[];
	disabledTools: Set<string>;
	diagnostics: string[];
}

export interface RuntimePolicyOptions {
	workspaceRoot: string;
	env?: Record<string, string | undefined>;
}

export function resolveRuntimePolicy(
	project: NightcodeConfig,
	options: RuntimePolicyOptions,
): RuntimePolicy {
	const env = options.env ?? process.env;
	const diagnostics: string[] = [];
	const userApproval = approvalMode(env.NIGHTCODE_APPROVAL_MODE) ?? "on-risk";
	const projectApproval = project.approvalMode;
	const effectiveApproval = stricterApproval(userApproval, projectApproval ?? userApproval);
	const denyRiskyTools = userApproval === "never" || projectApproval === "never";
	if (projectApproval && effectiveApproval !== projectApproval) {
		diagnostics.push(
			projectApproval === "never"
				? `approvalMode=never adds hard denials while preserving trusted ${userApproval} prompting`
				: `approvalMode=${projectApproval} was combined with stricter trusted prompting`,
		);
	}

	const userMode = env.NIGHTCODE_MODE === "PLAN" ? "PLAN" : "BUILD";
	const mode = userMode === "PLAN" || project.mode === "PLAN" ? "PLAN" : "BUILD";
	if (userMode === "PLAN" && project.mode === "BUILD") {
		diagnostics.push("mode=BUILD was ignored because project policy may not leave user PLAN mode");
	}

	const requirePlanByUser = env.NIGHTCODE_REQUIRE_PLAN_FOR_EDITS !== "false";
	const requirePlanForEdits = requirePlanByUser || project.requirePlanForEdits === true;
	if (project.requirePlanForEdits === false && requirePlanByUser) {
		diagnostics.push(
			"requirePlanForEdits=false was ignored because project policy may not disable safeguards",
		);
	}

	const allowedPaths = parseAbsolutePaths(env.NIGHTCODE_ALLOWED_PATHS, options.workspaceRoot);
	if ((project.allowedPaths?.length ?? 0) > 0) {
		diagnostics.push(
			"allowedPaths from project config were ignored; grant external roots with /allow or trusted NIGHTCODE_ALLOWED_PATHS",
		);
	}

	const disabledTools = new Set([
		...parseList(env.NIGHTCODE_DISABLED_TOOLS),
		...(project.disabledTools ?? []),
	]);
	if (disabledTools.delete("updateTaskPlan")) {
		diagnostics.push(
			"disabledTools cannot disable updateTaskPlan because it is a mutation safeguard",
		);
	}

	if (project.allowDangerousShell !== undefined) {
		diagnostics.push("allowDangerousShell is deprecated and ignored");
	}
	if (project.model && env.NIGHTCODE_ALLOW_PROJECT_MODEL !== "true") {
		diagnostics.push(
			`model=${project.model} was ignored; set NIGHTCODE_ALLOW_PROJECT_MODEL=true to trust project-selected models`,
		);
	}

	return {
		mode,
		approvalMode: effectiveApproval,
		denyRiskyTools,
		maxTokens: boundedProjectNumber(
			"maxTokens",
			env.NIGHTCODE_MAX_TOKENS,
			16_384,
			project.maxTokens,
			1,
			128_000,
			diagnostics,
		),
		maxRetries: boundedProjectNumber(
			"maxRetries",
			env.NIGHTCODE_MAX_RETRIES,
			2,
			project.maxRetries,
			0,
			10,
			diagnostics,
		),
		maxAgentSteps: boundedProjectNumber(
			"maxAgentSteps",
			env.NIGHTCODE_MAX_AGENT_STEPS,
			20,
			project.maxAgentSteps,
			1,
			200,
			diagnostics,
		),
		maxToolOutputChars: boundedProjectNumber(
			"maxToolOutputChars",
			env.NIGHTCODE_MAX_TOOL_OUTPUT_CHARS,
			60_000,
			project.maxToolOutputChars,
			1_000,
			1_000_000,
			diagnostics,
		),
		maxToolTimeoutMs: boundedProjectNumber(
			"maxToolTimeoutMs",
			env.NIGHTCODE_MAX_TOOL_TIMEOUT_MS,
			120_000,
			project.maxToolTimeoutMs,
			1_000,
			600_000,
			diagnostics,
		),
		maxRunDurationMs: boundedProjectNumber(
			"maxRunDurationMs",
			env.NIGHTCODE_MAX_RUN_DURATION_MS,
			900_000,
			project.maxRunDurationMs,
			10_000,
			3_600_000,
			diagnostics,
		),
		contextBudget: boundedProjectNumber(
			"contextBudget",
			env.NIGHTCODE_CONTEXT_BUDGET,
			16_000,
			project.contextBudget,
			1_000,
			1_000_000,
			diagnostics,
		),
		requirePlanForEdits,
		allowedPaths,
		disabledTools,
		diagnostics,
	};
}

function approvalMode(value: string | undefined): ApprovalMode | undefined {
	return value === "always" || value === "on-risk" || value === "never" ? value : undefined;
}

function stricterApproval(left: ApprovalMode, right: ApprovalMode): ApprovalMode {
	return APPROVAL_STRENGTH[left] >= APPROVAL_STRENGTH[right] ? left : right;
}

function boundedProjectNumber(
	name: string,
	envValue: string | undefined,
	fallback: number,
	projectValue: number | undefined,
	min: number,
	max: number,
	diagnostics: string[],
): number {
	const parsed = envValue === undefined ? fallback : Number(envValue);
	const userValue = Number.isFinite(parsed)
		? Math.min(max, Math.max(min, Math.floor(parsed)))
		: fallback;
	if (projectValue === undefined) return userValue;
	if (projectValue > userValue) {
		diagnostics.push(`${name}=${projectValue} was capped at the trusted limit ${userValue}`);
	}
	return Math.min(userValue, projectValue);
}

function parseList(value: string | undefined): string[] {
	return value
		? value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean)
		: [];
}

function expandHome(path: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home || (path !== "~" && !path.startsWith("~/") && !path.startsWith("~\\"))) return path;
	return path === "~" ? home : `${home}${path.slice(1)}`;
}

function parseAbsolutePaths(value: string | undefined, workspaceRoot: string): string[] {
	if (!value) return [];
	return value
		.split(delimiter)
		.map((entry) => expandHome(entry.trim()))
		.filter((entry) => entry && isAbsolute(entry))
		.map((entry) => resolve(entry))
		.filter((entry) => entry !== resolve(workspaceRoot));
}
