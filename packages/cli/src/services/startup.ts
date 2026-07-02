import { stat } from "node:fs/promises";
import { type LLMProvider, llm } from "@cli/services/llm";
import {
	listStoredSessions,
	loadLatestStoredSession,
	loadStoredSession,
	type StoredSession,
} from "@cli/services/sessions";
import { resolveUserPath } from "@cli/slash-commands";
import { clearRepositoryIndex } from "@nightcode/server/lib/context-engine";
import { getDefaultModelForProvider, getProviderForModel } from "@nightcode/shared";

export type InitialWorkspace = {
	root: string;
	warning?: string;
};

export type StartupState = {
	workspace: InitialWorkspace;
	session?: StoredSession;
	warning?: string;
};

const COMMAND_NAMES = new Set(["continue", "doctor", "resume", "ui-smoke"]);
const VALUE_FLAGS = new Set(["--workspace", "--cwd", "-w", "--resume", "-r", "--ui-smoke-ms"]);

function cliArgs(): string[] {
	return Bun.argv.slice(2);
}

function hasFlag(name: string): boolean {
	return cliArgs().some((arg) => arg === name);
}

function flagValue(...names: string[]): string | null {
	const args = cliArgs();

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) continue;

		for (const name of names) {
			if (arg === name) return args[index + 1] ?? null;
			if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
		}
	}

	return null;
}

export function isDoctorCommand(): boolean {
	const args = cliArgs();
	return args.includes("--doctor") || args[0] === "doctor";
}

function isContinueCommand(): boolean {
	const args = cliArgs();
	return args.includes("--continue") || args[0] === "continue";
}

export function isUiSmokeCommand(): boolean {
	const args = cliArgs();
	return args.includes("--ui-smoke") || args[0] === "ui-smoke";
}

function resumeSessionId(): string | null {
	const args = cliArgs();
	if (args[0] === "resume") return args[1] ?? null;
	return flagValue("--resume", "-r");
}

function isWorkspacePositional(arg: string): boolean {
	return !arg.startsWith("-") && !COMMAND_NAMES.has(arg);
}

export function uiSmokeMs(): number {
	const raw = Number(flagValue("--ui-smoke-ms") ?? process.env.NIGHTCODE_UI_SMOKE_MS ?? 700);
	return Number.isFinite(raw) && raw >= 100 ? Math.min(raw, 5000) : 700;
}

function combineWarnings(...warnings: Array<string | undefined>): string | undefined {
	const compact = warnings.filter((warning): warning is string => Boolean(warning));
	return compact.length > 0 ? compact.join("\n") : undefined;
}

function azureDeploymentModel(fallback: string): string {
	return (
		process.env.AZURE_OPENAI_DEPLOYMENT ??
		process.env.AZURE_OPENAI_DEPLOYMENT_ID ??
		process.env.AZURE_DEPLOYMENT ??
		fallback
	);
}

export function compatibleModelForProvider(provider: LLMProvider, currentModel: string): string {
	if (provider === "azure") return azureDeploymentModel(currentModel);

	return getProviderForModel(currentModel) === provider
		? currentModel
		: (getDefaultModelForProvider(provider) ?? currentModel);
}

function requestedWorkspace(): string | null {
	const args = cliArgs();

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) continue;

		if (arg === "--workspace" || arg === "--cwd" || arg === "-w") {
			return args[index + 1] ?? null;
		}

		if (arg.startsWith("--workspace=")) {
			return arg.slice("--workspace=".length);
		}

		if (arg.startsWith("--cwd=")) {
			return arg.slice("--cwd=".length);
		}
	}

	const positional = args.find((arg, index) => {
		if (!arg || !isWorkspacePositional(arg)) return false;
		const previous = args[index - 1];
		return previous ? !VALUE_FLAGS.has(previous) && previous !== "resume" : true;
	});
	return positional ?? process.env.NIGHTCODE_WORKSPACE ?? null;
}

export async function applyInitialWorkspace(): Promise<InitialWorkspace> {
	const requested = requestedWorkspace();
	if (!requested) {
		llm.setWorkspace(process.cwd());
		return { root: process.cwd() };
	}

	const resolved = resolveUserPath(requested);
	try {
		const info = await stat(resolved);
		if (!info.isDirectory()) {
			return {
				root: process.cwd(),
				warning: `Startup workspace is not a directory: ${resolved}`,
			};
		}

		process.chdir(resolved);
		llm.setWorkspace(resolved);
		clearRepositoryIndex();
		return { root: process.cwd() };
	} catch (error) {
		return {
			root: process.cwd(),
			warning: `Could not open startup workspace ${resolved}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

async function applySessionWorkspace(session: StoredSession): Promise<InitialWorkspace> {
	const resolved = resolveUserPath(session.cwd);
	const info = await stat(resolved);
	if (!info.isDirectory()) {
		throw new Error(`Saved session workspace is not a directory: ${resolved}`);
	}

	process.chdir(resolved);
	llm.setWorkspace(resolved);
	clearRepositoryIndex();
	return { root: process.cwd() };
}

export async function resolveStartupState(
	initialWorkspace: InitialWorkspace,
): Promise<StartupState> {
	const sessionId = resumeSessionId();
	if (sessionId) {
		const session = await loadStoredSession(sessionId);
		if (!session) {
			return {
				workspace: initialWorkspace,
				warning: combineWarnings(
					initialWorkspace.warning,
					`Could not resume session "${sessionId}": no exact or unique prefix match.`,
				),
			};
		}

		try {
			return {
				workspace: {
					...(await applySessionWorkspace(session)),
					warning: initialWorkspace.warning,
				},
				session,
				warning: initialWorkspace.warning,
			};
		} catch (error) {
			return {
				workspace: initialWorkspace,
				warning: combineWarnings(
					initialWorkspace.warning,
					`Could not resume session ${session.id}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				),
			};
		}
	}

	if (isContinueCommand()) {
		const session = await loadLatestStoredSession(initialWorkspace.root);
		if (!session) {
			return {
				workspace: initialWorkspace,
				warning: combineWarnings(
					initialWorkspace.warning,
					`No saved session found for workspace ${initialWorkspace.root}.`,
				),
			};
		}

		return {
			workspace: initialWorkspace,
			session,
			warning: initialWorkspace.warning,
		};
	}

	return { workspace: initialWorkspace, warning: initialWorkspace.warning };
}

function providerEnvStatus(): Record<string, boolean> {
	return {
		OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY?.trim()),
		ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
		AZURE_OPENAI_API_KEY: Boolean(process.env.AZURE_OPENAI_API_KEY?.trim()),
		AZURE_OPENAI_ENDPOINT: Boolean(process.env.AZURE_OPENAI_ENDPOINT?.trim()),
	};
}

export async function runDoctor(initialWorkspace: InitialWorkspace): Promise<void> {
	const sessions = await listStoredSessions({ cwd: initialWorkspace.root, limit: 100 });
	const report = {
		command: "nightcode",
		executable: Bun.argv[1] ?? null,
		bunVersion: Bun.version,
		cwd: process.cwd(),
		workspaceRoot: initialWorkspace.root,
		workspaceWarning: initialWorkspace.warning ?? null,
		serverUrl: process.env.NIGHTCODE_SERVER_URL ?? null,
		provider: llm.config.provider,
		model: llm.config.model,
		agentMode: llm.config.agentMode,
		savedSessionsForWorkspace: sessions.length,
		providerEnv: providerEnvStatus(),
	};

	if (hasFlag("--json")) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	const lines = [
		"Nightcode doctor",
		`Executable: ${report.executable ?? "unknown"}`,
		`Bun: ${report.bunVersion}`,
		`Workspace: ${report.workspaceRoot}`,
		`CWD: ${report.cwd}`,
		`Provider: ${report.provider}`,
		`Model: ${report.model}`,
		`Agent mode: ${report.agentMode ? "on" : "off"}`,
		`Saved sessions: ${report.savedSessionsForWorkspace}`,
		report.serverUrl ? `Server URL: ${report.serverUrl}` : null,
		report.workspaceWarning ? `Warning: ${report.workspaceWarning}` : null,
		"Provider env:",
		...Object.entries(report.providerEnv).map(
			([name, present]) => `  ${name}: ${present ? "present" : "missing"}`,
		),
	].filter((line): line is string => Boolean(line));

	process.stdout.write(`${lines.join("\n")}\n`);
}
