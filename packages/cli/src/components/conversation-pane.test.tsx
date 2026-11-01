import { expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, createRef } from "react";
import { ConversationPane } from "./conversation-pane";

test("conversation displays user and assistant messages in a terminal viewport", async () => {
	const setup = await testRender(
		<ConversationPane
			scrollRef={createRef<ScrollBoxRenderable>()}
			messages={[
				{ role: "user", content: "Explain the change" },
				{ role: "assistant", content: "The update is complete." },
			]}
			isLoading={false}
			streamingText=""
			toolActivities={[]}
			pendingApprovals={[]}
			model="test"
			provider="openai"
			agentMode
			workspaceRoot="workspace"
			getMessageKey={(message) => message.content}
		/>,
		{ width: 60, height: 16 },
	);
	try {
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("You");
		expect(frame).toContain("Explain the change");
		expect(frame).toContain("Night Code");
		expect(frame).toContain("The update is complete.");
	} finally {
		await act(async () => setup.renderer.destroy());
	}
});
