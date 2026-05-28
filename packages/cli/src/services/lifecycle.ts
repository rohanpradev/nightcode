/**
 * App Lifecycle Manages renderer creation, cleanup, and graceful exit.
 */

import type { CliRenderer } from "@opentui/core";

let rendererInstance: CliRenderer | null = null;

/**
 *Store the renderer reference for lifecycle management.
 */

export function setRenderer(renderer: CliRenderer): void {
	rendererInstance = renderer;
}
/**
 * Gracefully exit the application:
 * 1. Destroys the renderer (restores terminal from raw mode)
 * 2. Exits the process cleanly
 */

export function gracefulExit(code = 0): void {
	if (rendererInstance) {
		rendererInstance.destroy();
		rendererInstance = null;
	}
	process.exit(code);
}
