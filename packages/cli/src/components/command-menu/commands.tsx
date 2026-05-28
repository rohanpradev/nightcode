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
		description: "Add a file to context (e.g. /add src/index.ts)",
		value: "/add",
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
		description: "Grant access to an external path (e.g. /allow ~/projects)",
		value: "/allow",
		action: ({ showCommandUsage }) => showCommandUsage("/allow <directory-path>"),
	},
	{
		name: "cwd",
		description: "Change the working directory (e.g. /cwd ~/project)",
		value: "/cwd",
		action: ({ showCommandUsage }) => showCommandUsage("/cwd <directory-path>"),
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
		description: "Switch model (e.g. /model gpt-5.4)",
		value: "/model",
		action: ({ showCommandUsage }) => showCommandUsage("/model <model-id>"),
	},
	{
		name: "provider",
		description: "Switch provider: azure | anthropic | openai",
		value: "/provider",
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
		description: "Show or edit persistent memory / project instructions",
		value: "/memory",
		action: ({ showMemory }) => showMemory(),
	},
	{
		name: "doctor",
		description: "Check system health: API keys, connectivity, tools",
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
		description: "Toggle vim keybindings for the input",
		value: "/vim",
		action: ({ toggleVim }) => toggleVim(),
	},
	{
		name: "undo",
		description: "Undo the last AI-generated change (git reset)",
		value: "/undo",
		shortcut: "Ctrl+Z",
		action: ({ undoLastChange }) => undoLastChange(),
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
		name: "exit",
		description: "Exit the application",
		value: "/exit",
		shortcut: "Ctrl+D",
		action: ({ exit }) => exit(),
	},
];
