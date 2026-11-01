import { expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, createRef } from "react";
import { CommandMenu } from ".";
import { COMMANDS } from "./commands";

test("command menu renders and scrolls to a command beyond the initial viewport", async () => {
	const scrollRef = createRef<ScrollBoxRenderable>();
	const setup = await testRender(
		<CommandMenu
			query=""
			selectedIndex={0}
			scrollRef={scrollRef}
			onSelect={() => {}}
			onExecute={() => {}}
		/>,
		{ width: 80, height: 12 },
	);
	try {
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("Commands");
		expect(setup.captureCharFrame()).toContain("help");
		const last = COMMANDS.at(-1);
		expect(last).toBeDefined();
		scrollRef.current?.scrollChildIntoView(`command-${last?.name}`);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain(last?.name ?? "missing");
	} finally {
		await act(async () => setup.renderer.destroy());
	}
});
