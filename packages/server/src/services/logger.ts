type LogContext = Record<string, unknown>;
type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const configuredLevel = (process.env.NIGHTCODE_LOG_LEVEL ?? "info") as LogLevel;

function shouldLog(level: LogLevel): boolean {
	return levelOrder[level] >= (levelOrder[configuredLevel] ?? levelOrder.info);
}

function write(level: LogLevel, message: string, ctx?: LogContext): void {
	if (!shouldLog(level)) return;

	const payload = ctx ? ` ${JSON.stringify(ctx)}` : "";
	const line = `[nightcode] ${level.toUpperCase()} ${message}${payload}`;

	if (level === "error") {
		Bun.stderr.write(`${line}\n`);
	} else if (level === "warn") {
		Bun.stderr.write(`${line}\n`);
	} else {
		Bun.stdout.write(`${line}\n`);
	}
}

export const logger = {
	debug: (message: string, ctx?: LogContext) => write("debug", message, ctx),
	info: (message: string, ctx?: LogContext) => write("info", message, ctx),
	warn: (message: string, ctx?: LogContext) => write("warn", message, ctx),
	error: (message: string, ctx?: LogContext) => write("error", message, ctx),
	startTimer(label: string) {
		const startedAt = performance.now();
		return {
			stop(ctx?: LogContext) {
				write("debug", label, {
					...ctx,
					durationMs: Math.round(performance.now() - startedAt),
				});
			},
		};
	},
};

export type Logger = typeof logger;
