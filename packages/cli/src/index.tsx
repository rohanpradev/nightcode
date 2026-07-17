import { stat } from "node:fs/promises";
import { COMMANDS } from "@cli/components/command-menu/commands";
import type { CommandContext } from "@cli/components/command-menu/types";
import { ConversationPane } from "@cli/components/conversation-pane";
import { Header } from "@cli/components/header";
import { InputBar } from "@cli/components/input-bar";
import { gracefulExit, setBeforeExit, setRenderer } from "@cli/services/lifecycle";
import {
	type LLMMessage,
	type LLMProvider,
	type LLMStreamChunk,
	llm,
	type PendingApproval,
} from "@cli/services/llm";
import {
	createSessionId,
	listStoredSessions,
	loadLatestStoredSession,
	loadStoredSession,
	type StoredSession,
	saveStoredSession,
	titleFromMessages,
} from "@cli/services/sessions";
import {
	applyInitialWorkspace,
	compatibleModelForProvider,
	isDoctorCommand,
	isHelpCommand,
	isUiSmokeCommand,
	isVersionCommand,
	printCliHelp,
	printCliVersion,
	resolveStartupState,
	runDoctor,
	uiSmokeMs,
	validateCliArguments,
} from "@cli/services/startup";
import { completeToolActivity, type ToolActivity } from "@cli/services/tool-activity";
import { parseSlashCommand, resolveUserPath } from "@cli/slash-commands";
import { discoverAgentProfiles } from "@nightcode/server/lib/agent-profiles";
import {
	clearRepositoryIndex,
	compactMessages,
	generateRepomap,
	getSymbolCount,
	indexDirectory,
} from "@nightcode/server/lib/context-engine";
import { discoverLspServers } from "@nightcode/server/lib/lsp-config";
import { discoverSkills } from "@nightcode/server/lib/skills";
import {
	findSupportedChatModel,
	getProviderForModel,
	supportedChatModels,
} from "@nightcode/shared";
import {
	type CliRenderer,
	createCliRenderer,
	type KeyEvent,
	type ScrollBoxRenderable,
} from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";

type SessionStats = {
	startedAt: number;
	requests: number;
	toolCalls: number;
	lastLatencyMs?: number;
};

const MAX_PINNED_FILE_CHARS = 250_000;

type WorkspaceSwitchOptions = {
	announce?: boolean;
	resetSession?: boolean;
};

function App({
	initialWorkspaceRoot,
	initialWorkspaceWarning,
	initialSession,
	renderer,
}: {
	initialWorkspaceRoot: string;
	initialWorkspaceWarning?: string;
	initialSession?: StoredSession;
	renderer: CliRenderer;
}) {
	const [messages, setMessages] = useState<LLMMessage[]>(() =>
		initialSession
			? [
					...initialSession.messages,
					{
						role: "notice",
						content: `Resumed session ${initialSession.id} (${initialSession.title})`,
					},
				]
			: [],
	);
	const [streamingText, setStreamingText] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [model, setModel] = useState(llm.config.model);
	const [provider, setProvider] = useState<LLMProvider>(llm.config.provider);
	const [agentMode, setAgentMode] = useState(llm.config.agentMode);
	const [compactMode, setCompactMode] = useState(false);
	const [vimMode, setVimMode] = useState(false);
	const [tokenUsage, setTokenUsage] = useState({ input: 0, output: 0 });
	const [sessionStats, setSessionStats] = useState<SessionStats>({
		startedAt: Date.now(),
		requests: 0,
		toolCalls: 0,
	});
	const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
	const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
	const [fileContext, setFileContext] = useState<Map<string, string>>(
		() => new Map(initialSession?.fileContext.map((entry) => [entry.path, entry.content]) ?? []),
	);
	const [workspaceRoot, setWorkspaceRoot] = useState(initialWorkspaceRoot);
	const [sessionId, setSessionId] = useState(() => initialSession?.id ?? createSessionId());
	const [sessionCreatedAt, setSessionCreatedAt] = useState(
		() => initialSession?.createdAt ?? Date.now(),
	);
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	const messageKeysRef = useRef(new WeakMap<LLMMessage, string>());
	const activeAbortControllerRef = useRef<AbortController | null>(null);
	const saveErrorShownRef = useRef(false);
	const sessionSnapshotRef = useRef<StoredSession>({
		id: sessionId,
		title: titleFromMessages(messages),
		cwd: workspaceRoot,
		createdAt: sessionCreatedAt,
		updatedAt: Date.now(),
		messages,
		fileContext: Array.from(fileContext.entries()).map(([path, content]) => ({ path, content })),
	});
	sessionSnapshotRef.current = {
		id: sessionId,
		title: titleFromMessages(messages),
		cwd: workspaceRoot,
		createdAt: sessionCreatedAt,
		updatedAt: Date.now(),
		messages,
		fileContext: Array.from(fileContext.entries()).map(([path, content]) => ({ path, content })),
	};

	const persistCurrentSession = useCallback(
		async (overrides: Partial<Pick<StoredSession, "messages" | "fileContext">> = {}) => {
			const snapshot = { ...sessionSnapshotRef.current, ...overrides, updatedAt: Date.now() };
			snapshot.title = titleFromMessages(snapshot.messages);
			await saveStoredSession(snapshot);
			saveErrorShownRef.current = false;
		},
		[],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on any content change
	useEffect(() => {
		scrollRef.current?.scrollTo(Infinity);
	}, [messages, streamingText, toolActivities]);

	useEffect(() => {
		if (messages.length === 0 && fileContext.size === 0) return;

		const timeout = setTimeout(() => {
			void persistCurrentSession().catch((error) => {
				if (saveErrorShownRef.current) return;
				saveErrorShownRef.current = true;
				setMessages((previous) => [
					...previous,
					{
						role: "notice",
						content: `Session save failed: ${error instanceof Error ? error.message : String(error)}`,
					},
				]);
			});
		}, 300);

		return () => clearTimeout(timeout);
	}, [fileContext, messages, persistCurrentSession]);

	const systemMessage = useCallback(
		(content: string) => setMessages((prev) => [...prev, { role: "notice", content }]),
		[],
	);

	useEffect(() => {
		if (initialWorkspaceWarning) {
			systemMessage(initialWorkspaceWarning);
		}
	}, [initialWorkspaceWarning, systemMessage]);

	useEffect(() => {
		setBeforeExit(persistCurrentSession);
		return () => setBeforeExit(null);
	}, [persistCurrentSession]);

	useEffect(() => {
		const handleKeypress = (event: KeyEvent) => {
			if (!event.ctrl || event.name !== "c") return;
			event.preventDefault();
			event.stopPropagation();
			if (activeAbortControllerRef.current) {
				activeAbortControllerRef.current.abort("cancelled by user");
				return;
			}
			void gracefulExit();
		};
		renderer.keyInput.on("keypress", handleKeypress);
		return () => {
			renderer.keyInput.off("keypress", handleKeypress);
		};
	}, [renderer]);

	const getMessageKey = useCallback((message: LLMMessage) => {
		const existing = messageKeysRef.current.get(message);
		if (existing) return existing;

		const next = crypto.randomUUID();
		messageKeysRef.current.set(message, next);
		return next;
	}, []);

	const clearMessages = useCallback(async () => {
		await persistCurrentSession({ messages: [] });
		setMessages([]);
		setStreamingText("");
		setToolActivities([]);
	}, [persistCurrentSession]);

	const newConversation = useCallback(async () => {
		await persistCurrentSession();
		llm.setWorkspace(workspaceRoot);
		setSessionId(createSessionId());
		setSessionCreatedAt(Date.now());
		setMessages([{ role: "notice", content: "Started a new conversation." }]);
		setStreamingText("");
		setToolActivities([]);
		setPendingApprovals([]);
		setTokenUsage({ input: 0, output: 0 });
		setSessionStats({ startedAt: Date.now(), requests: 0, toolCalls: 0 });
	}, [persistCurrentSession, workspaceRoot]);

	const switchWorkspace = useCallback(
		async (path: string, options: WorkspaceSwitchOptions = {}) => {
			await persistCurrentSession();
			const resolved = resolveUserPath(path);
			const info = await stat(resolved);
			if (!info.isDirectory()) {
				throw new Error(`Not a directory: ${resolved}`);
			}

			process.chdir(resolved);
			llm.setWorkspace(resolved);
			clearRepositoryIndex(resolved);

			setWorkspaceRoot(process.cwd());
			setFileContext(new Map());
			setStreamingText("");
			setToolActivities([]);
			setPendingApprovals([]);
			setModel(llm.config.model);
			setProvider(llm.config.provider);
			setAgentMode(llm.config.agentMode);

			const announce = options.announce ?? true;
			if (options.resetSession ?? true) {
				const now = Date.now();
				setSessionId(createSessionId());
				setSessionCreatedAt(now);
				setTokenUsage({ input: 0, output: 0 });
				setSessionStats({ startedAt: now, requests: 0, toolCalls: 0 });
				setMessages(
					announce
						? [
								{
									role: "notice",
									content: `Workspace -> ${process.cwd()}\nFile context cleared. Agent access reset to this workspace plus configured allowed paths.`,
								},
							]
						: [],
				);
			} else if (announce) {
				systemMessage(`Workspace -> ${process.cwd()}`);
			}

			return process.cwd();
		},
		[persistCurrentSession, systemMessage],
	);

	const showHelp = useCallback(() => {
		const lines = [
			"Available commands:",
			...COMMANDS.map((cmd) => {
				const shortcut = cmd.shortcut ? ` (${cmd.shortcut})` : "";
				return `  ${cmd.name.padEnd(12)} ${cmd.description}${shortcut}`;
			}),
			"Tips:",
			"  Type / to open the command palette with fuzzy search",
			"  Use \u2191/\u2193 or Tab to navigate, Enter to select",
			"  Press Escape to dismiss the menu",
		];
		systemMessage(lines.join("\n"));
	}, [systemMessage]);

	const handleSetModel = useCallback(
		(newModel: string) => {
			const inferredProvider = provider === "azure" ? undefined : getProviderForModel(newModel);
			const nextProvider = inferredProvider ?? provider;
			llm.configure({ provider: nextProvider, model: newModel });
			setProvider(nextProvider);
			setModel(newModel);
			systemMessage(
				nextProvider === provider
					? `Model \u2192 ${newModel}`
					: `Provider \u2192 ${nextProvider}\nModel \u2192 ${newModel}`,
			);
		},
		[provider, systemMessage],
	);

	const handleSetProvider = useCallback(
		(p: LLMProvider) => {
			const nextModel = compatibleModelForProvider(p, model);
			llm.configure({ provider: p, model: nextModel });
			setProvider(p);
			setModel(nextModel);
			systemMessage(
				nextModel === model
					? `Provider \u2192 ${p}`
					: `Provider \u2192 ${p}\nModel \u2192 ${nextModel}`,
			);
		},
		[model, systemMessage],
	);

	const handleToggleAgent = useCallback(() => {
		const next = !llm.config.agentMode;
		llm.configure({ agentMode: next });
		setAgentMode(next);
		systemMessage(
			next
				? "Agent mode ON \u2014 tools enabled (shell, files, skills, grep/glob)"
				: "Agent mode OFF \u2014 plain chat only",
		);
	}, [systemMessage]);

	const handleToggleCompact = useCallback(() => {
		setCompactMode((prev) => {
			const next = !prev;
			systemMessage(
				next
					? "Compact mode ON \u2014 older turns will be condensed into a clearly labeled context note"
					: "Compact mode OFF \u2014 full message history preserved",
			);
			return next;
		});
	}, [systemMessage]);

	const handleShowStatus = useCallback(() => {
		const providers = llm.getAvailableProviders();
		const lines = [
			"\u2500\u2500\u2500 Status \u2500\u2500\u2500",
			`  Provider:    ${provider}`,
			`  Model:       ${model}`,
			`  Agent mode:  ${agentMode ? "ON \u2713" : "OFF"}`,
			`  Compact:     ${compactMode ? "ON" : "OFF"}`,
			`  Vim mode:    ${vimMode ? "ON" : "OFF"}`,
			`  Workspace:   ${workspaceRoot}`,
			`  Context:     ${fileContext.size} file(s)`,
			`  Max tokens:  ${llm.config.maxTokens}`,
			`  Temperature: ${llm.config.temperature}`,
			"  Providers:",
			...providers.map((p) => `    ${p.available ? "\u2713" : "\u2717"} ${p.provider}`),
		];
		systemMessage(lines.join("\n"));
	}, [
		provider,
		model,
		agentMode,
		compactMode,
		vimMode,
		workspaceRoot,
		fileContext.size,
		systemMessage,
	]);

	const handleShowCost = useCallback(() => {
		const modelInfo = findSupportedChatModel(model);
		if (!modelInfo?.pricing) {
			const lines = [
				"\u2500\u2500\u2500 Session Cost \u2500\u2500\u2500",
				`  Input tokens:  ${tokenUsage.input.toLocaleString()}`,
				`  Output tokens: ${tokenUsage.output.toLocaleString()}`,
				`  Total tokens:  ${(tokenUsage.input + tokenUsage.output).toLocaleString()}`,
				`  Pricing:       unavailable for ${provider}/${model}`,
			];
			systemMessage(lines.join("\n"));
			return;
		}

		const inputRate = modelInfo.pricing.inputUsdPerMillionTokens;
		const outputRate = modelInfo.pricing.outputUsdPerMillionTokens;
		const inputCost = (tokenUsage.input / 1_000_000) * inputRate;
		const outputCost = (tokenUsage.output / 1_000_000) * outputRate;
		const totalCost = inputCost + outputCost;
		const lines = [
			"\u2500\u2500\u2500 Session Cost \u2500\u2500\u2500",
			`  Input tokens:  ${tokenUsage.input.toLocaleString()}`,
			`  Output tokens: ${tokenUsage.output.toLocaleString()}`,
			`  Total tokens:  ${(tokenUsage.input + tokenUsage.output).toLocaleString()}`,
			`  Estimated cost: $${totalCost.toFixed(4)}`,
			`  Rates: $${inputRate}/M input, $${outputRate}/M output`,
			`  Based on ${provider}/${model}${modelInfo ? "" : " fallback"} pricing`,
		];
		systemMessage(lines.join("\n"));
	}, [tokenUsage, provider, model, systemMessage]);

	const handleShowModels = useCallback(() => {
		const knownModels = supportedChatModels.filter((entry) => entry.provider === provider);
		if (provider === "azure") {
			systemMessage(
				[
					"\u2500\u2500\u2500 Models \u2500\u2500\u2500",
					"  Azure uses your deployment name as the model id.",
					`  Current deployment: ${model}`,
					"  Set with /model <deployment-id>.",
				].join("\n"),
			);
			return;
		}

		if (knownModels.length === 0) {
			systemMessage(`No known models registered for ${provider}. Use /model <model-id>.`);
			return;
		}

		const lines = [
			"\u2500\u2500\u2500 Models \u2500\u2500\u2500",
			...knownModels.map((entry) => {
				const active = entry.id === model ? "*" : " ";
				const fallback = entry.defaultForProvider ? " default" : "";
				const price = entry.pricing
					? ` $${entry.pricing.inputUsdPerMillionTokens}/M in, $${entry.pricing.outputUsdPerMillionTokens}/M out`
					: " pricing n/a";
				return `  ${active} ${entry.id.padEnd(24)} ${entry.label}${fallback};${price}`;
			}),
			"",
			"Use /model <model-id> to switch.",
		];
		systemMessage(lines.join("\n"));
	}, [model, provider, systemMessage]);

	const handleShowMemory = useCallback(() => {
		const lines = [
			"\u2500\u2500\u2500 Memory \u2500\u2500\u2500",
			"  Project instructions are loaded from:",
			"  \u2022 .nightcode/instructions.md",
			"  \u2022 AGENTS.md",
			"  \u2022 .github/copilot-instructions.md",
			"  \u2022 CLAUDE.md, GEMINI.md, .cursor/rules, .codex/instructions.md",
			"  Agent skills can live in .agents/skills or .github/skills.",
			"  Custom profiles can live in .github/agents.",
			`  Current system prompt: ${llm.config.systemPrompt ? "custom" : "default"}`,
		];
		systemMessage(lines.join("\n"));
	}, [systemMessage]);

	const handleShowSkills = useCallback(() => {
		const skills = discoverSkills(workspaceRoot);
		if (skills.length === 0) {
			systemMessage(
				"No skills found. Add SKILL.md files under .agents/skills, .github/skills, or .nightcode/skills.",
			);
			return;
		}

		const lines = [
			"\u2500\u2500\u2500 Skills \u2500\u2500\u2500",
			...skills.map(
				(skill) =>
					`  ${skill.id.padEnd(18)} ${skill.scope.padEnd(7)} ${skill.name} - ${skill.description}`,
			),
			"",
			"The agent can use listSkills and loadSkill during a task.",
		];
		systemMessage(lines.join("\n"));
	}, [systemMessage, workspaceRoot]);

	const handleShowAgentProfiles = useCallback(() => {
		const profiles = discoverAgentProfiles(workspaceRoot);
		if (profiles.length === 0) {
			systemMessage("No custom agent profiles found. Add Markdown files under .github/agents.");
			return;
		}

		const lines = [
			"\u2500\u2500\u2500 Custom Agents \u2500\u2500\u2500",
			...profiles.map(
				(profile) =>
					`  ${profile.id.padEnd(18)} ${profile.scope.padEnd(7)} ${profile.name} - ${profile.description}`,
			),
			"",
			"The agent can use listAgentProfiles and loadAgentProfile during a task.",
		];
		systemMessage(lines.join("\n"));
	}, [systemMessage, workspaceRoot]);

	const handleShowLspServers = useCallback(() => {
		const servers = discoverLspServers(workspaceRoot);
		if (servers.length === 0) {
			systemMessage(
				"No LSP servers configured. Add .github/lsp.json, .nightcode/lsp.json, or ~/.copilot/lsp-config.json.",
			);
			return;
		}

		const lines = [
			"\u2500\u2500\u2500 LSP Servers \u2500\u2500\u2500",
			...servers.map((server) => {
				const extensions = server.fileExtensions
					? ` [${Object.keys(server.fileExtensions).join(", ")}]`
					: "";
				return `  ${server.id.padEnd(18)} ${server.scope.padEnd(7)} ${
					server.command ?? "(command not set)"
				}${extensions}`;
			}),
		];
		systemMessage(lines.join("\n"));
	}, [systemMessage, workspaceRoot]);

	const handleShowTaskPlan = useCallback(() => {
		const plan = llm.getTaskPlan();
		if (plan.items.length === 0) {
			systemMessage("No active task plan. The agent will create one before mutating files.");
			return;
		}

		const lines = [
			"\u2500\u2500\u2500 Task Plan \u2500\u2500\u2500",
			plan.summary ? `  Summary: ${plan.summary}` : "  Summary: n/a",
			...plan.items.map((item) => {
				const note = item.note ? ` - ${item.note}` : "";
				return `  ${item.status.padEnd(11)} ${item.id}: ${item.title}${note}`;
			}),
		];
		if (plan.verification.length > 0) {
			lines.push("", "  Verification:");
			lines.push(...plan.verification.map((entry) => `  - ${entry}`));
		}
		if (plan.updatedAt) {
			lines.push("", `  Updated: ${plan.updatedAt}`);
		}
		systemMessage(lines.join("\n"));
	}, [systemMessage]);

	const handleShowContext = useCallback(() => {
		if (fileContext.size === 0) {
			systemMessage("No files in context. Use /add <path> to add files.");
			return;
		}

		const lines = ["\u2500\u2500\u2500 File Context \u2500\u2500\u2500", ""];
		let totalChars = 0;
		for (const [path, content] of fileContext) {
			totalChars += content.length;
			lines.push(`  \u2022 ${path} (${content.length.toLocaleString()} chars)`);
		}
		lines.push("", `  Total: ${fileContext.size} file(s), ${totalChars.toLocaleString()} chars`);
		lines.push("  Use /clear-context to remove all");
		systemMessage(lines.join("\n"));
	}, [fileContext, systemMessage]);

	const handleClearFileContext = useCallback(() => {
		setFileContext(new Map());
		systemMessage("File context cleared.");
	}, [systemMessage]);

	const handleToggleVim = useCallback(() => {
		setVimMode((prev) => {
			const next = !prev;
			systemMessage(next ? "Vim mode ON" : "Vim mode OFF");
			return next;
		});
	}, [systemMessage]);

	const handleDoctor = useCallback(() => {
		const providers = llm.getAvailableProviders();
		const checks: string[] = ["\u2500\u2500\u2500 Doctor \u2500\u2500\u2500", ""];

		// Check providers
		for (const p of providers) {
			checks.push(
				`  ${p.available ? "\u2713" : "\u2717"} ${p.provider} ${
					p.available ? "ready" : (p.reason ?? "not configured")
				}`,
			);
		}
		checks.push("");

		// Check active provider
		const activeProvider = providers.find((p) => p.provider === provider);
		if (activeProvider?.available) {
			checks.push(`  \u2713 Active provider (${provider}) is healthy`);
		} else {
			checks.push(`  \u2717 Active provider (${provider}) is not available`);
			checks.push(
				`  Configure ${
					provider === "anthropic"
						? "ANTHROPIC_API_KEY"
						: provider === "openai"
							? "OPENAI_API_KEY"
							: "AZURE_API_KEY"
				} before sending requests.`,
			);
		}
		checks.push("");

		// Agent mode status
		if (agentMode) {
			checks.push("  \u2713 Agent mode enabled");
			checks.push(
				"  Tools: updateTaskPlan, shell, readFile, readLines, writeFile, editFile, multiEdit, listFiles, fileInfo, listAgentProfiles, loadAgentProfile, listSkills, loadSkill, listLspServers, glob, grep",
			);
		} else {
			checks.push("  \u2022 Agent mode disabled (use /agent to enable)");
		}

		checks.push("", "Configuration checks complete. No network request was made.");
		systemMessage(checks.join("\n"));
	}, [provider, agentMode, systemMessage]);

	const handleShowStats = useCallback(() => {
		const uptimeSec = Math.max(1, Math.round((Date.now() - sessionStats.startedAt) / 1000));
		const lines = [
			"\u2500\u2500\u2500 Session Stats \u2500\u2500\u2500",
			`  Requests:     ${sessionStats.requests}`,
			`  Session:      ${sessionId}`,
			`  Tool calls:   ${sessionStats.toolCalls}`,
			`  Tokens:       ${(tokenUsage.input + tokenUsage.output).toLocaleString()}`,
			`  Uptime:       ${uptimeSec}s`,
			`  Last latency: ${sessionStats.lastLatencyMs == null ? "n/a" : `${sessionStats.lastLatencyMs}ms`}`,
		];
		systemMessage(lines.join("\n"));
	}, [sessionStats, sessionId, tokenUsage, systemMessage]);

	const handleListSessions = useCallback(async () => {
		const sessions = await listStoredSessions({ cwd: workspaceRoot });
		if (sessions.length === 0) {
			systemMessage(`No saved sessions for workspace ${workspaceRoot}.`);
			return;
		}

		const lines = [
			"\u2500\u2500\u2500 Sessions \u2500\u2500\u2500",
			...sessions.map((session) => {
				const updated = new Date(session.updatedAt).toLocaleString();
				return `  ${session.id}  ${updated}  ${session.title}  (${session.cwd})`;
			}),
			"",
			"Use /resume <session-id> to restore one.",
			"Startup flags also work: nightcode --continue or nightcode --resume <session-id>.",
		];
		systemMessage(lines.join("\n"));
	}, [systemMessage, workspaceRoot]);

	const handleResumeSession = useCallback(
		async (id: string) => {
			const session = await loadStoredSession(id);
			if (!session) {
				systemMessage(`Session not found or ambiguous: ${id}`);
				return;
			}

			try {
				await switchWorkspace(session.cwd, { announce: false, resetSession: false });
			} catch (error) {
				systemMessage(
					`Cannot resume ${session.id}: workspace unavailable at ${session.cwd} (${
						error instanceof Error ? error.message : String(error)
					})`,
				);
				return;
			}

			setSessionId(session.id);
			setSessionCreatedAt(session.createdAt);
			setMessages([
				...session.messages,
				{
					role: "notice",
					content: `Resumed session ${session.id} (${session.title})`,
				},
			]);
			setFileContext(new Map(session.fileContext.map((entry) => [entry.path, entry.content])));
			setStreamingText("");
			setToolActivities([]);
			setPendingApprovals([]);
		},
		[systemMessage, switchWorkspace],
	);

	const handleContinueSession = useCallback(async () => {
		const session = await loadLatestStoredSession(workspaceRoot);
		if (!session) {
			systemMessage(`No saved session for workspace ${workspaceRoot}.`);
			return;
		}

		await handleResumeSession(session.id);
	}, [handleResumeSession, systemMessage, workspaceRoot]);

	const handleIndexProject = useCallback(async () => {
		systemMessage(`Indexing ${workspaceRoot}...`);
		try {
			clearRepositoryIndex(workspaceRoot);
			const indexedFiles = await indexDirectory(workspaceRoot);
			systemMessage(
				`Indexed ${indexedFiles} file(s), ${getSymbolCount(workspaceRoot)} symbol(s). Use /map for a compact repository map.`,
			);
		} catch (err) {
			systemMessage(`Index failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, [systemMessage, workspaceRoot]);

	const handleShowRepoMap = useCallback(() => {
		const symbolCount = getSymbolCount(workspaceRoot);
		if (symbolCount === 0) {
			systemMessage("No repository map yet. Run /index first.");
			return;
		}
		systemMessage(generateRepomap(2500, workspaceRoot));
	}, [systemMessage, workspaceRoot]);

	const handleShowCommandUsage = useCallback(
		(command: string) => systemMessage(`Usage: ${command}`),
		[systemMessage],
	);

	async function consumeAgentStream(stream: AsyncIterable<LLMStreamChunk>): Promise<{
		text: string;
		toolCalls: number;
		finishReason?: string;
	}> {
		let text = "";
		let toolCalls = 0;
		let finishReason: string | undefined;
		for await (const chunk of stream) {
			switch (chunk.type) {
				case "text":
					text += chunk.text;
					setStreamingText(text);
					break;

				case "tool-call":
					toolCalls++;
					setToolActivities((prev) => [
						...prev,
						{
							id: chunk.toolCall.id ?? crypto.randomUUID(),
							name: chunk.toolCall.name,
							args: chunk.toolCall.args,
							status: "pending",
							startedAt: Date.now(),
						},
					]);
					break;

				case "tool-result":
					setToolActivities((prev) => {
						const matchId = chunk.toolResult.toolCallId ?? chunk.toolResult.id;
						const index = matchId
							? prev.findIndex((activity) => activity.id === matchId)
							: prev.findLastIndex(
									(activity) => activity.name === chunk.toolResult.name && activity.result == null,
								);
						if (index < 0) return prev;
						return prev.map((activity, activityIndex) =>
							activityIndex === index
								? completeToolActivity(activity, {
										result: chunk.toolResult.result,
										isError: chunk.toolResult.isError,
									})
								: activity,
						);
					});
					break;

				case "approval-request":
					setPendingApprovals((prev) => [
						...prev.filter((approval) => approval.id !== chunk.approval.id),
						chunk.approval,
					]);
					break;

				case "approval-response":
					setPendingApprovals((prev) =>
						prev.filter((approval) => approval.id !== chunk.approval.id),
					);
					break;

				case "aborted":
					systemMessage(`Run stopped${chunk.reason ? `: ${chunk.reason}` : "."}`);
					finishReason = "aborted";
					break;

				case "error":
					throw new Error(chunk.error);

				case "done":
					finishReason = chunk.finishReason;
					if (chunk.usage) {
						setTokenUsage((prev) => ({
							input: prev.input + (chunk.usage?.inputTokens ?? 0),
							output: prev.output + (chunk.usage?.outputTokens ?? 0),
						}));
					}
					break;
			}
		}
		return { text, toolCalls, finishReason };
	}

	const handleShowApprovals = useCallback(() => {
		const approvals = llm.getPendingApprovals();
		if (approvals.length === 0) {
			systemMessage("No tool actions are waiting for approval.");
			return;
		}
		systemMessage(
			`${approvals.length} tool action${approvals.length === 1 ? " is" : "s are"} waiting. Review the approval card below.`,
		);
	}, [systemMessage]);

	const handleUndoLastChange = useCallback(async () => {
		try {
			systemMessage(await llm.undoLastPatch());
		} catch (error) {
			systemMessage(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, [systemMessage]);

	async function handleResolveApproval(id: string, approved: boolean): Promise<void> {
		const approvals = llm.getPendingApprovals();
		const approvalId = id || (approvals.length === 1 ? (approvals[0]?.id ?? "") : "");
		if (!approvalId || !approvals.some((approval) => approval.id === approvalId)) {
			systemMessage(
				approvals.length === 0
					? "No tool actions are waiting for approval."
					: `Approval not found. Use /approvals and then /${approved ? "approve" : "deny"} <id>.`,
			);
			return;
		}

		const startedAt = Date.now();
		const abortController = new AbortController();
		activeAbortControllerRef.current = abortController;
		setIsLoading(true);
		setStreamingText("");
		try {
			const outcome = await consumeAgentStream(
				llm.resolveApproval(
					{ approvalId, approved, reason: approved ? undefined : "Denied by user" },
					{ sessionId, abortSignal: abortController.signal },
				),
			);
			if (outcome.text) {
				setMessages((prev) => [...prev, { role: "assistant", content: outcome.text }]);
			}
			setSessionStats((prev) => ({
				...prev,
				requests: prev.requests + 1,
				toolCalls: prev.toolCalls + outcome.toolCalls,
				lastLatencyMs: Date.now() - startedAt,
			}));
		} catch (error) {
			systemMessage(error instanceof Error ? error.message : String(error));
		} finally {
			activeAbortControllerRef.current = null;
			setIsLoading(false);
			setStreamingText("");
		}
	}

	const commandContext: CommandContext = {
		exit: gracefulExit,
		clear: clearMessages,
		newConversation,
		switchWorkspace,
		showHelp,
		setModel: handleSetModel,
		setProvider: handleSetProvider,
		toggleAgent: handleToggleAgent,
		toggleCompact: handleToggleCompact,
		showStatus: handleShowStatus,
		showCost: handleShowCost,
		showModels: handleShowModels,
		showMemory: handleShowMemory,
		showSkills: handleShowSkills,
		showAgentProfiles: handleShowAgentProfiles,
		showLspServers: handleShowLspServers,
		showTaskPlan: handleShowTaskPlan,
		showContext: handleShowContext,
		clearFileContext: handleClearFileContext,
		toggleVim: handleToggleVim,
		doctor: handleDoctor,
		undoLastChange: handleUndoLastChange,
		showApprovals: handleShowApprovals,
		showStats: handleShowStats,
		indexProject: handleIndexProject,
		showRepoMap: handleShowRepoMap,
		listSessions: handleListSessions,
		continueSession: handleContinueSession,
		resumeSession: handleResumeSession,
		submitPrompt: (prompt) => handleSubmit(prompt),
		showCommandUsage: handleShowCommandUsage,
		currentModel: model,
		currentProvider: provider,
		agentMode,
		compactMode,
		vimMode,
	};

	async function handleSubmit(value: string) {
		const trimmed = value.trim();
		if (!trimmed) return;
		if (trimmed === "/stop") {
			if (activeAbortControllerRef.current) {
				activeAbortControllerRef.current.abort("cancelled by user");
			} else {
				systemMessage("No run is active.");
			}
			return;
		}
		if (isLoading) return;

		// Handle parameterized slash commands
		const slashCommand = parseSlashCommand(trimmed);
		if (slashCommand) {
			const { name, arg } = slashCommand;

			if (name === "model") {
				if (arg) handleSetModel(arg);
				else systemMessage("Usage: /model <model-id>");
				return;
			}

			if (name === "provider") {
				if (["azure", "anthropic", "openai"].includes(arg)) {
					handleSetProvider(arg as LLMProvider);
				} else {
					systemMessage(`Unknown provider "${arg || "(empty)"}". Use: azure, anthropic, openai`);
				}
				return;
			}

			if (name === "add") {
				if (!arg) {
					systemMessage("Usage: /add <file-path>");
					return;
				}
				try {
					const resolvedPath = resolveUserPath(arg);
					const info = await stat(resolvedPath);
					if (!info.isFile()) {
						systemMessage(`Not a file: ${resolvedPath}`);
						return;
					}

					const file = Bun.file(resolvedPath);
					const content = await file.text();
					const pinnedContent =
						content.length > MAX_PINNED_FILE_CHARS
							? `${content.slice(0, MAX_PINNED_FILE_CHARS)}\n\n[truncated ${
									content.length - MAX_PINNED_FILE_CHARS
								} chars]`
							: content;
					setFileContext((prev) => new Map(prev).set(resolvedPath, pinnedContent));
					systemMessage(
						`\u2713 Added ${resolvedPath} to context (${pinnedContent.length.toLocaleString()} chars)`,
					);
				} catch (err) {
					systemMessage(`Error reading file: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}

			if (name === "allow") {
				if (!arg) {
					systemMessage("Usage: /allow <directory-path>");
					return;
				}
				const resolved = resolveUserPath(arg);
				try {
					const info = await stat(resolved);
					if (!info.isDirectory()) {
						systemMessage(`Not a directory: ${resolved}`);
						return;
					}
				} catch {
					systemMessage(`Directory not found: ${resolved}`);
					return;
				}
				llm.addAllowedPath(resolved);
				systemMessage(`Allowed path: ${resolved}\nAgent can now read/write files there.`);
				return;
			}

			if (name === "cwd" || name === "workspace") {
				if (!arg) {
					systemMessage(`Usage: /${name} <directory-path>`);
					return;
				}
				try {
					await switchWorkspace(arg);
				} catch (error) {
					systemMessage(
						`Error: Cannot open workspace ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
				return;
			}

			if (name === "resume") {
				if (!arg) {
					systemMessage("Usage: /resume <session-id>");
					return;
				}
				await handleResumeSession(arg);
				return;
			}

			if (name === "approve" || name === "deny") {
				await handleResolveApproval(arg, name === "approve");
				return;
			}

			const cmd = COMMANDS.find((c) => c.name === name);
			if (cmd?.action && !arg) {
				await cmd.action(commandContext);
				return;
			}

			systemMessage(`Unknown command "/${name}". Type /help for available commands.`);
			return;
		}

		// Build user message with file context
		let userContent = trimmed;
		if (fileContext.size > 0) {
			const contextBlock = Array.from(fileContext.entries())
				.map(([path, content]) => `<file path="${path}">\n${content}\n</file>`)
				.join("\n\n");
			userContent = `${contextBlock}\n\n${trimmed}`;
		}

		const userMessage: LLMMessage = { role: "user", content: userContent };
		const updatedMessages = [...messages, { role: "user" as const, content: trimmed }];

		setMessages(updatedMessages);
		setIsLoading(true);
		setStreamingText("");
		setToolActivities([]);
		const requestStartedAt = Date.now();
		const abortController = new AbortController();
		activeAbortControllerRef.current = abortController;

		try {
			const messagesForLLM = compactMode
				? (compactMessages([...messages, userMessage], 8) as LLMMessage[])
				: [...messages, userMessage];
			const outcome = await consumeAgentStream(
				llm.stream(messagesForLLM, undefined, {
					sessionId,
					abortSignal: abortController.signal,
				}),
			);
			if (outcome.text) {
				setMessages((prev) => [...prev, { role: "assistant", content: outcome.text }]);
			} else if (!["approval-required", "aborted"].includes(outcome.finishReason ?? "")) {
				setMessages((prev) => [...prev, { role: "assistant", content: "(no response)" }]);
			}
			setSessionStats((prev) => ({
				...prev,
				requests: prev.requests + 1,
				toolCalls: prev.toolCalls + outcome.toolCalls,
				lastLatencyMs: Date.now() - requestStartedAt,
			}));
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			setMessages((prev) => [...prev, { role: "notice", content: `Error: ${msg}` }]);
			setSessionStats((prev) => ({
				...prev,
				requests: prev.requests + 1,
				lastLatencyMs: Date.now() - requestStartedAt,
			}));
		} finally {
			activeAbortControllerRef.current = null;
			setIsLoading(false);
			setStreamingText("");
		}
	}

	return (
		<box alignItems="center" backgroundColor="#11111b" height="100%" width="100%">
			<Header />
			<box
				width="100%"
				maxWidth={100}
				paddingX={2}
				paddingBottom={1}
				flexGrow={1}
				flexShrink={1}
				overflow="hidden"
				gap={0}
			>
				<ConversationPane
					scrollRef={scrollRef}
					messages={messages}
					isLoading={isLoading}
					streamingText={streamingText}
					toolActivities={toolActivities}
					pendingApprovals={pendingApprovals}
					model={model}
					provider={provider}
					agentMode={agentMode}
					workspaceRoot={workspaceRoot}
					getMessageKey={getMessageKey}
				/>

				<InputBar
					onSubmit={handleSubmit}
					commandContext={commandContext}
					disabled={isLoading}
					vimMode={vimMode}
				/>
			</box>
		</box>
	);
}

async function main(): Promise<void> {
	validateCliArguments();
	if (isHelpCommand()) {
		printCliHelp();
		return;
	}
	if (isVersionCommand()) {
		printCliVersion();
		return;
	}
	const initialWorkspace = await applyInitialWorkspace();
	const startup = await resolveStartupState(initialWorkspace);
	if (isDoctorCommand()) {
		await runDoctor({ ...startup.workspace, warning: startup.warning });
		process.exit(0);
	}

	const renderer = await createCliRenderer({ exitOnCtrlC: false });
	setRenderer(renderer);
	createRoot(renderer).render(
		<App
			initialWorkspaceRoot={startup.workspace.root}
			initialWorkspaceWarning={startup.warning}
			initialSession={startup.session}
			renderer={renderer}
		/>,
	);

	if (isUiSmokeCommand()) {
		setTimeout(() => {
			renderer.destroy();
			process.stdout.write(`\nNightcode UI smoke OK: ${startup.workspace.root}\n`);
			process.exit(0);
		}, uiSmokeMs());
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
