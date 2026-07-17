/**
 * App Lifecycle Manages renderer creation, cleanup, and graceful exit.
 */

import type { CliRenderer } from "@opentui/core";

let rendererInstance: CliRenderer | null = null;
let beforeExit: (() => Promise<void>) | null = null;
let exitInProgress = false;

/**
 *Store the renderer reference for lifecycle management.
 */

export function setRenderer(renderer: CliRenderer): void {
	rendererInstance = renderer;
}

export function setBeforeExit(handler: (() => Promise<void>) | null): void {
	beforeExit = handler;
}
/**
 * Gracefully exit the application:
 * 1. Destroys the renderer (restores terminal from raw mode)
 * 2. Exits the process cleanly
 */

export async function gracefulExit(code = 0): Promise<void> {
	if (exitInProgress) return;
	exitInProgress = true;
	let exitError: unknown;
	try {
		await beforeExit?.();
	} catch (error) {
		exitError = error;
	}
	if (rendererInstance) {
		rendererInstance.destroy();
		rendererInstance = null;
	}
	if (exitError) {
		process.stderr.write(
			`Nightcode could not save the active session: ${
				exitError instanceof Error ? exitError.message : String(exitError)
			}\n`,
		);
	}
	process.exit(code);
}
