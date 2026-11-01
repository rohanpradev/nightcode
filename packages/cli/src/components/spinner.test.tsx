import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { Spinner } from "./spinner";

test("spinner advances using the renderer animation clock", async () => {
	const setup = await testRender(<Spinner showElapsed={false} />, { width: 30, height: 3 });
	try {
		await act(async () => {
			await setup.renderOnce();
			const initial = setup.captureCharFrame();
			expect(initial).toContain("Thinking");
			await Bun.sleep(250);
			await setup.renderOnce();
			expect(setup.captureCharFrame()).not.toBe(initial);
		});
	} finally {
		await act(async () => setup.renderer.destroy());
	}
});
