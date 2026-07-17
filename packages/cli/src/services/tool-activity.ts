export type ToolActivityStatus = "pending" | "succeeded" | "failed";

export type ToolActivity = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: ToolActivityStatus;
	result?: string;
	startedAt: number;
	durationMs?: number;
};

type ToolActivityCompletion = {
	result: string;
	isError?: boolean;
};

const DEFAULT_RESULT_PREVIEW_CHARS = 140;

function compactPreview(value: string, maxLength: number): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
}

function objectPath(value: unknown): string | null {
	if (!value || typeof value !== "object" || !("path" in value)) return null;
	return typeof value.path === "string" ? value.path : null;
}

export function completeToolActivity(
	activity: ToolActivity,
	completion: ToolActivityCompletion,
	completedAt = Date.now(),
): ToolActivity {
	return {
		...activity,
		status: completion.isError ? "failed" : "succeeded",
		result: completion.result,
		durationMs: Math.max(0, completedAt - activity.startedAt),
	};
}

export function formatToolResultPreview(
	activity: ToolActivity,
	maxLength = DEFAULT_RESULT_PREVIEW_CHARS,
): string {
	if (activity.status === "pending") return "";

	const preview = compactPreview(activity.result ?? "", maxLength);
	if (preview) return preview;
	return activity.status === "failed" ? "(no error output)" : "(no output)";
}

export function formatApprovalArgs(
	toolName: string,
	args: Record<string, unknown>,
	maxLength = 240,
): string {
	const detail = formatToolCallArgs(toolName, args, maxLength);
	return detail || "(no arguments)";
}

export function formatToolArgs(activity: ToolActivity): string {
	return formatToolCallArgs(activity.name, activity.args, 80);
}

function formatToolCallArgs(
	name: string,
	args: Record<string, unknown>,
	maxLength: number,
): string {
	switch (name) {
		case "shell":
			return compactPreview(String(args.command ?? ""), maxLength);
		case "readFile":
		case "writeFile":
			return String(args.path ?? "");
		case "applyPatch": {
			if (!Array.isArray(args.operations)) return String(args.path ?? "");
			const paths = args.operations.map(objectPath).filter((path): path is string => path !== null);
			const detail = paths.length > 0 ? `: ${paths.join(", ")}` : "";
			return compactPreview(`${args.operations.length} operation(s)${detail}`, maxLength);
		}
		case "editFile":
			return String(args.path ?? "");
		case "multiEdit":
			return `${args.path} (${Array.isArray(args.edits) ? args.edits.length : 0} edits)`;
		case "readLines":
			return `${args.path}:${args.startLine}-${args.endLine}`;
		case "grep":
			return `/${String(args.pattern ?? "").slice(0, 25)}/${args.include ?? ""}`;
		case "glob":
			return String(args.pattern ?? "");
		case "listFiles":
			return String(args.path ?? ".");
		case "updateTaskPlan":
			return String(args.summary ?? "task plan");
		case "getTaskPlan":
			return "current plan";
		case "loadAgentProfile":
			return String(args.profileId ?? "");
		case "listAgentProfiles":
			return "custom agents";
		case "loadSkill":
			return String(args.skillId ?? "");
		case "listSkills":
			return "available skills";
		case "listLspServers":
			return "configured LSP";
		case "undoLastPatch":
			return "last Night Code checkpoint";
		default: {
			const serialized = JSON.stringify(args);
			return compactPreview(serialized ?? "", maxLength);
		}
	}
}
