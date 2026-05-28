import { resolve } from "node:path";
import { COMMANDS } from "@cli/components/command-menu/commands";
import type { CommandContext } from "@cli/components/command-menu/types";
import { Header } from "@cli/components/header";
import { InputBar } from "@cli/components/input-bar";
import { Spinner } from "@cli/components/spinner";
import { gracefulExit, setRenderer } from "@cli/services/lifecycle";
import { type LLMMessage, type LLMProvider, llm } from "@cli/services/llm";
import {
	compactMessages,
	generateRepomap,
	getSymbolCount,
	indexDirectory,
} from "@nightcode/server/lib/context-engine";
import { findSupportedChatModel } from "@nightcode/shared";
import { createCliRenderer, type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";

type ToolActivity = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: string;
	startedAt: number;
	durationMs?: number;
};

type SessionStats = {
	startedAt: number;
	requests: number;
	toolCalls: number;
	lastLatencyMs?: number;
};

function formatToolArgs(activity: ToolActivity): string {
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
		default:
			return JSON.stringify(args).slice(0, 40);
	}
}

function App() {
	const [messages, setMessages] = useState<LLMMessage[]>([]);
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
	const [fileContext, setFileContext] = useState<Map<string, string>>(new Map());
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on any content change
	useEffect(() => {
		scrollRef.current?.scrollTo(Infinity);
	}, [messages, streamingText, toolActivities]);

	const systemMessage = useCallback(
		(content: string) => setMessages((prev) => [...prev, { role: "system", content }]),
		[],
	);

	const clearMessages = useCallback(() => {
		setMessages([]);
		setStreamingText("");
	}, []);

	const newConversation = useCallback(() => {
		setMessages([{ role: "system", content: "Started a new conversation." }]);
		setStreamingText("");
		setTokenUsage({ input: 0, output: 0 });
		setSessionStats({ startedAt: Date.now(), requests: 0, toolCalls: 0 });
	}, []);

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
			llm.configure({ model: newModel });
			setModel(newModel);
			systemMessage(`Model \u2192 ${newModel}`);
		},
		[systemMessage],
	);

	const handleSetProvider = useCallback(
		(p: LLMProvider) => {
			llm.configure({ provider: p });
			setProvider(p);
			systemMessage(`Provider \u2192 ${p}`);
		},
		[systemMessage],
	);

	const handleToggleAgent = useCallback(() => {
		const next = !llm.config.agentMode;
		llm.configure({ agentMode: next });
		setAgentMode(next);
		systemMessage(
			next
				? "Agent mode ON \u2014 tools enabled (shell, file read/write, web search)"
				: "Agent mode OFF \u2014 plain chat only",
		);
	}, [systemMessage]);

	const handleToggleCompact = useCallback(() => {
		setCompactMode((prev) => {
			const next = !prev;
			systemMessage(
				next
					? "Compact mode ON \u2014 older messages will be summarized to save context"
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
			`  CWD:         ${process.cwd()}`,
			`  Context:     ${fileContext.size} file(s)`,
			`  Max tokens:  ${llm.config.maxTokens}`,
			`  Temperature: ${llm.config.temperature}`,
			"  Providers:",
			...providers.map((p) => `    ${p.available ? "\u2713" : "\u2717"} ${p.provider}`),
		];
		systemMessage(lines.join("\n"));
	}, [provider, model, agentMode, compactMode, vimMode, fileContext.size, systemMessage]);

	const handleShowCost = useCallback(() => {
		const modelInfo = findSupportedChatModel(model);
		const inputRate = modelInfo?.pricing.inputUsdPerMillionTokens ?? 3;
		const outputRate = modelInfo?.pricing.outputUsdPerMillionTokens ?? 15;
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

	const handleShowMemory = useCallback(() => {
		const lines = [
			"\u2500\u2500\u2500 Memory \u2500\u2500\u2500",
			"  Project instructions and memory are loaded from:",
			"  \u2022 .claudecode (project root)",
			"  \u2022 ~/.config/claudecode/memory.md (global)",
			"  To edit project memory, create or modify .claudecode",
			"  in your project root with markdown instructions.",
			`  Current system prompt: ${llm.config.systemPrompt ? "custom" : "default"}`,
		];
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
				`  ${p.available ? "\u2713" : "\u2717"} ${p.provider} ${p.available ? "connected" : "not configured"}`,
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
				`  Run: export ${
					provider === "anthropic"
						? "ANTHROPIC_API_KEY"
						: provider === "openai"
							? "OPENAI_API_KEY"
							: "AZURE_API_KEY"
				}=<key>`,
			);
		}
		checks.push("");

		// Agent mode status
		if (agentMode) {
			checks.push("  \u2713 Agent mode enabled");
			checks.push("  Tools: shell_exec, file_read, file_write, web_search");
		} else {
			checks.push("  \u2022 Agent mode disabled (use /agent to enable)");
		}

		checks.push("", "All checks complete.");
		systemMessage(checks.join("\n"));
	}, [provider, agentMode, systemMessage]);

	const handleShowStats = useCallback(() => {
		const uptimeSec = Math.max(1, Math.round((Date.now() - sessionStats.startedAt) / 1000));
		const lines = [
			"\u2500\u2500\u2500 Session Stats \u2500\u2500\u2500",
			`  Requests:     ${sessionStats.requests}`,
			`  Tool calls:   ${sessionStats.toolCalls}`,
			`  Tokens:       ${(tokenUsage.input + tokenUsage.output).toLocaleString()}`,
			`  Uptime:       ${uptimeSec}s`,
			`  Last latency: ${sessionStats.lastLatencyMs == null ? "n/a" : `${sessionStats.lastLatencyMs}ms`}`,
		];
		systemMessage(lines.join("\n"));
	}, [sessionStats, tokenUsage, systemMessage]);

	const handleIndexProject = useCallback(async () => {
		const cwd = process.cwd();
		systemMessage(`Indexing ${cwd}...`);
		try {
			const indexedFiles = await indexDirectory(cwd);
			systemMessage(
				`Indexed ${indexedFiles} file(s), ${getSymbolCount()} symbol(s). Use /map for a compact repository map.`,
			);
		} catch (err) {
			systemMessage(`Index failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, [systemMessage]);

	const handleShowRepoMap = useCallback(() => {
		const symbolCount = getSymbolCount();
		if (symbolCount === 0) {
			systemMessage("No repository map yet. Run /index first.");
			return;
		}
		systemMessage(generateRepomap(2500));
	}, [systemMessage]);

	const handleShowCommandUsage = useCallback(
		(command: string) => systemMessage(`Usage: ${command}`),
		[systemMessage],
	);

	const commandContext: CommandContext = {
		exit: gracefulExit,
		clear: clearMessages,
		newConversation,
		showHelp,
		setModel: handleSetModel,
		setProvider: handleSetProvider,
		toggleAgent: handleToggleAgent,
		toggleCompact: handleToggleCompact,
		showStatus: handleShowStatus,
		showCost: handleShowCost,
		showMemory: handleShowMemory,
		showContext: handleShowContext,
		clearFileContext: handleClearFileContext,
		toggleVim: handleToggleVim,
		doctor: handleDoctor,
		undoLastChange: () => systemMessage("Reverting last AI change... (git reset --soft HEAD~1)"),
		showStats: handleShowStats,
		indexProject: handleIndexProject,
		showRepoMap: handleShowRepoMap,
		listSessions: () => systemMessage("Sessions: Use /new to start a new session."),
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
		if (!trimmed || isLoading) return;

		const promptShortcuts: Record<string, string> = {
			"/plan":
				"Inspect the project, identify the smallest safe implementation plan, call out risks, and wait for my confirmation before editing files.",
			"/fix":
				"Find the highest-impact bug or incomplete implementation related to the current context, fix it, and run the most relevant verification.",
			"/review":
				"Review the current project for bugs, risky behavior, missing verification, and CLI usability issues. Lead with findings and include file references.",
			"/explain":
				"Explain the project architecture, the main runtime flow, and the files I should read first. Keep it concise and concrete.",
			"/test":
				"Run the relevant project checks, summarize any failures with exact commands and files, and fix straightforward issues.",
		};

		const promptShortcut = promptShortcuts[trimmed];
		if (promptShortcut) {
			await handleSubmit(promptShortcut);
			return;
		}

		// Handle parameterized slash commands
		if (trimmed.startsWith("/model ")) {
			const arg = trimmed.slice(7).trim();
			if (arg) handleSetModel(arg);
			return;
		}

		if (trimmed.startsWith("/provider ")) {
			const arg = trimmed.slice(10).trim() as LLMProvider;
			if (["azure", "anthropic", "openai"].includes(arg)) {
				handleSetProvider(arg);
			} else {
				systemMessage(`Unknown provider "${arg}". Use: azure, anthropic, openai`);
			}
			return;
		}

		if (trimmed.startsWith("/add ")) {
			const filePath = trimmed.slice(5).trim();
			if (!filePath) {
				systemMessage("Usage: /add <file-path>");
				return;
			}
			try {
				const resolvedPath = resolve(filePath.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ""));
				const file = Bun.file(resolvedPath);
				if (!(await file.exists())) {
					systemMessage(`File not found: ${filePath}`);
					return;
				}
				const content = await file.text();
				setFileContext((prev) => new Map(prev).set(resolvedPath, content));
				systemMessage(`\u2713 Added ${resolvedPath} to context (${content.length} chars)`);
			} catch (err) {
				systemMessage(`Error reading file: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}

		if (trimmed === "/context") {
			handleShowContext();
			return;
		}

		if (trimmed === "/clear-context") {
			handleClearFileContext();
			return;
		}

		if (trimmed.startsWith("/allow ")) {
			const dirPath = trimmed.slice(7).trim();
			if (!dirPath) {
				systemMessage("Usage: /allow <directory-path>");
				return;
			}
			const resolved = resolve(dirPath.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ""));
			llm.addAllowedPath(resolved);
			systemMessage(`Allowed path: ${resolved}\nAgent can now read/write files there.`);
			return;
		}

		if (trimmed.startsWith("/cwd ")) {
			const dirPath = trimmed.slice(5).trim();
			if (!dirPath) {
				systemMessage("Usage: /cwd <directory-path>");
				return;
			}
			const resolved = resolve(dirPath.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ""));
			try {
				process.chdir(resolved);
				systemMessage(`Working directory \u2192 ${process.cwd()}`);
			} catch {
				systemMessage(`Error: Cannot chdir to ${resolved} - directory does not exist.`);
			}
			return;
		}

		// Non-parameterized slash commands are handled via CommandMenu actions
		if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
			const cmdName = trimmed.slice(1);
			const cmd = COMMANDS.find((c) => c.name === cmdName);
			if (cmd?.action) {
				cmd.action(commandContext);
				return;
			}
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
		let requestToolCalls = 0;

		try {
			let accumulated = "";
			const messagesForLLM = compactMode
				? (compactMessages([...messages, userMessage], 8) as LLMMessage[])
				: [...messages, userMessage];

			for await (const chunk of llm.stream(messagesForLLM)) {
				switch (chunk.type) {
					case "text":
						accumulated += chunk.text;
						setStreamingText(accumulated);
						break;

					case "tool-call": {
						const tc = chunk.toolCall;
						if (tc) {
							requestToolCalls++;
							setToolActivities((prev) => [
								...prev,
								{
									id: crypto.randomUUID(),
									name: tc.name,
									args: tc.args,
									startedAt: Date.now(),
								},
							]);
						}
						break;
					}

					case "tool-result": {
						const tr = chunk.toolResult;
						if (tr) {
							setToolActivities((prev) => {
								const updated = [...prev];
								const last = updated.findLast((t) => t.name === tr.name && !t.result);
								if (last) {
									last.result = tr.result;
									last.durationMs = Date.now() - last.startedAt;
								}
								return updated;
							});
						}
						break;
					}

					case "done":
						if (chunk.usage) {
							setTokenUsage((prev) => ({
								input: prev.input + (chunk.usage?.inputTokens ?? 0),
								output: prev.output + (chunk.usage?.outputTokens ?? 0),
							}));
						}
						break;
				}
			}

			setMessages((prev) => [
				...prev,
				{ role: "assistant", content: accumulated || "(no response)" },
			]);
			setSessionStats((prev) => ({
				...prev,
				requests: prev.requests + 1,
				toolCalls: prev.toolCalls + requestToolCalls,
				lastLatencyMs: Date.now() - requestStartedAt,
			}));
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			setMessages((prev) => [...prev, { role: "system", content: `Error: ${msg}` }]);
			setSessionStats((prev) => ({
				...prev,
				requests: prev.requests + 1,
				toolCalls: prev.toolCalls + requestToolCalls,
				lastLatencyMs: Date.now() - requestStartedAt,
			}));
		} finally {
			setIsLoading(false);
			setStreamingText("");
			setToolActivities([]);
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
				<scrollbox
					ref={scrollRef}
					flexGrow={1}
					flexShrink={1}
					overflow="hidden"
					stickyScroll
					paddingBottom={1}
				>
					{!messages.length && !isLoading && (
						<box justifyContent="center" alignItems="center" paddingY={2} gap={1}>
							<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
								{"\u2726 Night Code"}
							</text>
							<text fg="#6c7086">{"Terminal-first AI coding agent"}</text>
							<box paddingTop={1} gap={0.5} alignItems="center">
								<box flexDirection="row" gap={1}>
									<text fg="#585670">{"\u2022"}</text>
									<text fg="#abadc8">{"Type a message to start coding"}</text>
								</box>
								<box flexDirection="row" gap={1}>
									<text fg="#585670">{"\u2022"}</text>
									<text fg="#abadc8">{"Use"}</text>
									<text fg="#89b4fa" attributes={TextAttributes.BOLD}>
										{"/"}
									</text>
									<text fg="#abadc8">{" for commands"}</text>
								</box>
								<box flexDirection="row" gap={1}>
									<text fg="#585670">{"\u2022"}</text>
									<text fg="#abadc8">{`${model} via ${provider}`}</text>
									<text fg={agentMode ? "#a6e3a1" : "#585678"}>{agentMode ? " \u26a1" : ""}</text>
								</box>
							</box>
						</box>
					)}

					{messages.map((msg) => (
						<box key={`${msg.role}-${msg.content}`} overflow="hidden">
							{msg.role === "user" && (
								<box overflow="hidden" paddingLeft={1}>
									<box flexDirection="row" gap={1}>
										<text fg="#74c7ec" attributes={TextAttributes.BOLD}>
											{"\u276f"}
										</text>
										<text fg="#74c7ec" attributes={TextAttributes.BOLD}>
											You
										</text>
									</box>
									<box paddingLeft={3} overflow="hidden">
										<text fg="#cdd6f4">{msg.content}</text>
									</box>
								</box>
							)}

							{msg.role === "assistant" && (
								<box overflow="hidden" flexDirection="row" paddingY={0.5} marginLeft={1}>
									<box width={0} border={["left"]} borderColor="#cba6f7" borderStyle="heavy" />
									<box paddingLeft={1} overflow="hidden">
										<box flexDirection="row" gap={1} paddingBottom={0.5}>
											<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
												{"\u2726"}
											</text>
											<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
												Night Code
											</text>
										</box>
										<text fg="#cdd6f4">{msg.content}</text>
									</box>
								</box>
							)}

							{msg.role === "system" && (
								<box flexDirection="row" gap={1} paddingLeft={2} overflow="hidden">
									<text fg="#45475a">{"\u2500"}</text>
									<text fg="#6c7086" attributes={TextAttributes.DIM}>
										{msg.content}
									</text>
								</box>
							)}
						</box>
					))}

					{isLoading && streamingText && (
						<box
							overflow="hidden"
							paddingBottom={0.5}
							flexDirection="row"
							paddingY={0.5}
							marginLeft={1}
						>
							<box width={0} border={["left"]} borderColor="#89b4fa" borderStyle="heavy" />
							<box paddingLeft={1} overflow="hidden">
								<box flexDirection="row" gap={1} paddingBottom={0.5}>
									<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
										{"\u2726"}
									</text>
									<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
										Night Code
									</text>
									<text fg="#f9e2af" attributes={TextAttributes.DIM}>
										{"\u2022 streaming"}
									</text>
								</box>

								{toolActivities.length > 0 && (
									<box paddingBottom={0.5} gap={0}>
										{toolActivities.map((activity) => (
											<box
												key={`tool-${activity.id}`}
												flexDirection="row"
												gap={1}
												overflow="hidden"
											>
												<text fg={activity.result ? "#a6e3a1" : "#f9e2af"}>
													{activity.result ? "\u2713" : "\u25cb"}
												</text>
												<text fg="#89b4fa">{activity.name}</text>
												<text fg="#585b70" attributes={TextAttributes.DIM}>
													{formatToolArgs(activity)}
												</text>
												{activity.durationMs != null && (
													<text fg="#45475a" attributes={TextAttributes.DIM}>
														{`${activity.durationMs}ms`}
													</text>
												)}
											</box>
										))}
									</box>
								)}

								<box overflow="hidden">
									<text fg="#a6adc8">{streamingText}</text>
								</box>
							</box>
						</box>
					)}

					{isLoading && !streamingText && (
						<box paddingLeft={2} paddingY={0.5}>
							<Spinner
								label={
									toolActivities.length > 0
										? `${toolActivities[toolActivities.length - 1]?.name}`
										: "Thinking"
								}
								color="#cba6f7"
							/>
							{toolActivities.length > 0 && (
								<box paddingLeft={3} paddingTop={0.5} gap={0}>
									{toolActivities.map((activity) => (
										<box
											key={`tool-wait-${activity.id}`}
											flexDirection="row"
											gap={1}
											overflow="hidden"
										>
											<text fg={activity.result ? "#a6e3a1" : "#f9e2af"}>
												{activity.result ? "\u2713" : "\u25cb"}
											</text>
											<text fg="#89b4fa" attributes={TextAttributes.BOLD}>
												{activity.name}
											</text>
											<text fg="#585b70" attributes={TextAttributes.DIM}>
												{formatToolArgs(activity)}
											</text>
											{activity.durationMs != null && (
												<text fg="#45475a" attributes={TextAttributes.DIM}>
													{`${activity.durationMs}ms`}
												</text>
											)}
										</box>
									))}
								</box>
							)}
						</box>
					)}
				</scrollbox>

				<InputBar onSubmit={handleSubmit} commandContext={commandContext} disabled={isLoading} />
			</box>
		</box>
	);
}

const renderer = await createCliRenderer();
setRenderer(renderer);
createRoot(renderer).render(<App />);
