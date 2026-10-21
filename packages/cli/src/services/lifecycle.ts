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
 * 1. Saves the active session
 * 2. Destroys the renderer and waits for terminal restoration
 * 3. Exits the process cleanly
 */

export async function gracefulExit(code = 0): Promise<void> {
	if (exitInProgress) return;
	exitInProgress = true;
	let exitError: unknown;
	let rendererError: unknown;
	try {
		await beforeExit?.();
	} catch (error) {
		exitError = error;
	}
	if (rendererInstance) {
		const renderer = rendererInstance;
		rendererInstance = null;
		try {
			renderer.destroy();
			await renderer.closed;
		} catch (error) {
			rendererError = error;
		}
	}
	if (exitError) {
		process.stderr.write(
			`Nightcode could not save the active session: ${
				exitError instanceof Error ? exitError.message : String(exitError)
			}\n`,
		);
	}
	if (rendererError) {
		process.stderr.write(
			`Nightcode could not restore the terminal: ${
				rendererError instanceof Error ? rendererError.message : String(rendererError)
			}\n`,
		);
	}
	process.exit(exitError || rendererError ? 1 : code);
}
