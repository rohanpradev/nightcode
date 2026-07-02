export type ToolActivity = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: string;
	startedAt: number;
	durationMs?: number;
};

export function formatToolArgs(activity: ToolActivity): string {
	const { name, args } = activity;
	switch (name) {
		case "shell":
			return String(args.command ?? "").slice(0, 50);
		case "readFile":
		case "writeFile":
			return String(args.path ?? "");
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
		default:
			return JSON.stringify(args).slice(0, 40);
	}
}
