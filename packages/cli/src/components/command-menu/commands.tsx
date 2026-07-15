import type { CommandItem } from "@cli/components/command-menu/types";

export const COMMANDS: CommandItem[] = [
	{
		name: "help",
		description: "Show available commands and keyboard shortcuts",
		value: "/help",
		shortcut: "?",
		action: ({ showHelp }) => showHelp(),
	},
	{
		name: "add",
		description: "Add a file to pinned context",
		value: "/add",
		inputTemplate: "/add ",
		action: ({ showCommandUsage }) => showCommandUsage("/add <file-path>"),
	},
	{
		name: "context",
		description: "Show files currently in context",
		value: "/context",
		action: ({ showContext }) => showContext(),
	},
	{
		name: "clear-context",
		description: "Remove all files from context",
		value: "/clear-context",
		action: ({ clearFileContext }) => clearFileContext(),
	},
	{
		name: "allow",
		description: "Grant access to an external directory",
		value: "/allow",
		inputTemplate: "/allow ",
		action: ({ showCommandUsage }) => showCommandUsage("/allow <directory-path>"),
	},
	{
		name: "cwd",
		description: "Alias for /workspace",
		value: "/cwd",
		inputTemplate: "/cwd ",
		action: ({ showCommandUsage }) => showCommandUsage("/cwd <directory-path>"),
	},
	{
		name: "workspace",
		description: "Open or switch the active repository",
		value: "/workspace",
		inputTemplate: "/workspace ",
		action: ({ showCommandUsage }) => showCommandUsage("/workspace <directory-path>"),
	},
	{
		name: "new",
		description: "Start a new conversation (preserves history)",
		value: "/new",
		shortcut: "Ctrl+N",
		action: ({ newConversation }) => newConversation(),
	},
	{
		name: "clear",
		description: "Clear the screen and conversation history",
		value: "/clear",
		shortcut: "Ctrl+L",
		action: ({ clear }) => clear(),
	},
	{
		name: "model",
		description: "Switch model",
		value: "/model",
		inputTemplate: "/model ",
		action: ({ showCommandUsage }) => showCommandUsage("/model <model-id>"),
	},
	{
		name: "models",
		description: "List known models for the active provider",
		value: "/models",
		action: ({ showModels }) => showModels(),
	},
	{
		name: "provider",
		description: "Switch provider: azure | anthropic | openai",
		value: "/provider",
		inputTemplate: "/provider ",
		action: ({ showCommandUsage }) => showCommandUsage("/provider azure|anthropic|openai"),
	},
	{
		name: "agent",
		description: "Toggle agentic mode (tool use: shell, files)",
		value: "/agent",
		shortcut: "Ctrl+A",
		action: ({ toggleAgent }) => toggleAgent(),
	},
	{
		name: "status",
		description: "Show current config, provider health, and telemetry",
		value: "/status",
		action: ({ showStatus }) => showStatus(),
	},
	{
		name: "compact",
		description: "Toggle compact mode (condense messages to save tokens)",
		value: "/compact",
		action: ({ toggleCompact }) => toggleCompact(),
	},
	{
		name: "cost",
		description: "Show token usage and estimated cost for this session",
		value: "/cost",
		action: ({ showCost }) => showCost(),
	},
	{
		name: "memory",
		description: "Show loaded project instructions and memory sources",
		value: "/memory",
		action: ({ showMemory }) => showMemory(),
	},
	{
		name: "skills",
		description: "Show available project and global agent skills",
		value: "/skills",
		action: ({ showSkills }) => showSkills(),
	},
	{
		name: "agents",
		description: "Show custom agent profiles",
		value: "/agents",
		action: ({ showAgentProfiles }) => showAgentProfiles(),
	},
	{
		name: "lsp",
		description: "Show configured language servers",
		value: "/lsp",
		action: ({ showLspServers }) => showLspServers(),
	},
	{
		name: "todo",
		description: "Show the current agent task plan",
		value: "/todo",
		action: ({ showTaskPlan }) => showTaskPlan(),
	},
	{
		name: "doctor",
		description: "Check provider configuration and agent-tool availability",
		value: "/doctor",
		action: ({ doctor }) => doctor(),
	},
	{
		name: "plan",
		description: "Ask the agent for a concise implementation plan",
		value: "/plan",
		action: ({ submitPrompt }) =>
			submitPrompt(
				"Inspect the project, identify the smallest safe implementation plan, call out risks, and wait for my confirmation before editing files.",
			),
	},
	{
		name: "fix",
		description: "Find and fix the highest-impact issue in the current task",
		value: "/fix",
		action: ({ submitPrompt }) =>
			submitPrompt(
				"Find the highest-impact bug or incomplete implementation related to the current context, fix it, and run the most relevant verification.",
			),
	},
	{
		name: "review",
		description: "Review the project like a senior coding agent",
		value: "/review",
		action: ({ submitPrompt }) =>
			submitPrompt(
				"Review the current project for bugs, risky behavior, missing verification, and CLI usability issues. Lead with findings and include file references.",
			),
	},
	{
		name: "explain",
		description: "Explain the architecture and important code paths",
		value: "/explain",
		action: ({ submitPrompt }) =>
			submitPrompt(
				"Explain the project architecture, the main runtime flow, and the files I should read first. Keep it concise and concrete.",
			),
	},
	{
		name: "test",
		description: "Run the relevant checks and summarize failures",
		value: "/test",
		action: ({ submitPrompt }) =>
			submitPrompt(
				"Run the relevant project checks, summarize any failures with exact commands and files, and fix straightforward issues.",
			),
	},
	{
		name: "vim",
		description: "Toggle Vim insert/normal mode for the input",
		value: "/vim",
		action: ({ toggleVim }) => toggleVim(),
	},
	{
		name: "undo",
		description: "Restore the most recent Night Code patch checkpoint",
		value: "/undo",
		shortcut: "Ctrl+Z",
		action: ({ undoLastChange }) => undoLastChange(),
	},
	{
		name: "approvals",
		description: "Show tool actions waiting for your decision",
		value: "/approvals",
		action: ({ showApprovals }) => showApprovals(),
	},
	{
		name: "approve",
		description: "Approve a pending tool action",
		value: "/approve",
		inputTemplate: "/approve ",
		action: ({ showCommandUsage }) => showCommandUsage("/approve <approval-id>"),
	},
	{
		name: "deny",
		description: "Deny a pending tool action",
		value: "/deny",
		inputTemplate: "/deny ",
		action: ({ showCommandUsage }) => showCommandUsage("/deny <approval-id>"),
	},
	{
		name: "stop",
		description: "Cancel the active model or tool run",
		value: "/stop",
		action: ({ submitPrompt }) => submitPrompt("/stop"),
	},
	{
		name: "stats",
		description: "Show session stats: tokens, cost, tool calls, latency",
		value: "/stats",
		action: ({ showStats }) => showStats(),
	},
	{
		name: "index",
		description: "Re-index the codebase for context engine",
		value: "/index",
		action: ({ indexProject }) => indexProject(),
	},
	{
		name: "map",
		description: "Show a compact repository symbol map",
		value: "/map",
		action: ({ showRepoMap }) => showRepoMap(),
	},
	{
		name: "sessions",
		description: "List and resume previous sessions",
		value: "/sessions",
		action: ({ listSessions }) => listSessions(),
	},
	{
		name: "continue",
		description: "Resume the latest saved session for this workspace",
		value: "/continue",
		action: ({ continueSession }) => continueSession(),
	},
	{
		name: "resume",
		description: "Resume a saved session",
		value: "/resume",
		inputTemplate: "/resume ",
		action: ({ showCommandUsage }) => showCommandUsage("/resume <session-id>"),
	},
	{
		name: "exit",
		description: "Exit the application",
		value: "/exit",
		shortcut: "Ctrl+D",
		action: ({ exit }) => exit(),
	},
];
