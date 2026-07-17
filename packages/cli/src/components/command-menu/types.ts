import type { LLMProvider } from "@/cli/services/llm";

export type CommandContext = {
	exit: () => void | Promise<void>;
	clear: () => void | Promise<void>;
	newConversation: () => void | Promise<void>;
	switchWorkspace: (path: string) => Promise<unknown>;
	showHelp: () => void;
	setModel: (model: string) => void;
	setProvider: (provider: LLMProvider) => void;
	toggleAgent: () => void;
	toggleCompact: () => void;
	showStatus: () => void;
	showCost: () => void;
	showModels: () => void;
	showMemory: () => void;
	showSkills: () => void;
	showAgentProfiles: () => void;
	showLspServers: () => void;
	showTaskPlan: () => void;
	showContext: () => void;
	clearFileContext: () => void;
	toggleVim: () => void;
	doctor: () => void;
	undoLastChange: () => void;
	showApprovals: () => void;
	showStats: () => void;
	indexProject: () => void | Promise<void>;
	showRepoMap: () => void;
	listSessions: () => void;
	continueSession: () => void | Promise<void>;
	resumeSession: (id: string) => void | Promise<void>;
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
	inputTemplate?: string;
	shortcut?: string;
	action: (context: CommandContext) => void | Promise<void>;
};
