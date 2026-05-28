import type { LLMProvider } from "@/cli/services/llm";

export type CommandContext = {
	exit: () => void;
	clear: () => void;
	newConversation: () => void;
	showHelp: () => void;
	setModel: (model: string) => void;
	setProvider: (provider: LLMProvider) => void;
	toggleAgent: () => void;
	toggleCompact: () => void;
	showStatus: () => void;
	showCost: () => void;
	showMemory: () => void;
	showContext: () => void;
	clearFileContext: () => void;
	toggleVim: () => void;
	doctor: () => void;
	undoLastChange: () => void;
	showStats: () => void;
	indexProject: () => void | Promise<void>;
	showRepoMap: () => void;
	listSessions: () => void;
	submitPrompt: (prompt: string) => void | Promise<void>;
	showCommandUsage: (command: string) => void;
	currentModel: string;
	currentProvider: LLMProvider;
	agentMode: boolean;
	compactMode: boolean;
	vimMode: boolean;
};

export type CommandItem = {
	name: string;
	description: string;
	value: string;
	shortcut?: string;
	action: (context: CommandContext) => void | Promise<void>;
};
