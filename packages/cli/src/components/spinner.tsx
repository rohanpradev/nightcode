import { TextAttributes } from "@opentui/core";
import { useEffect, useState } from "react";

const SPINNER_FRAMES = [
	"\u2801",
	"\u2809",
	"\u2819",
	"\u281b",
	"\u283b",
	"\u2839",
	"\u2838",
	"\u2830",
	"\u2820",
	"\u2824",
	"\u2826",
	"\u2827",
];

const FRAME_INTERVAL = 80;

type Props = {
	label?: string;
	color?: string;
	showElapsed?: boolean;
};

export function Spinner({ label = "Thinking", color = "#cba6f7", showElapsed = true }: Props) {
	const [frame, setFrame] = useState(0);
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		const id = setInterval(() => {
			setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
		}, FRAME_INTERVAL);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		if (!showElapsed) return;
		const id = setInterval(() => {
			setElapsed((e) => e + 1);
		}, 1000);
		return () => clearInterval(id);
	}, [showElapsed]);

	const elapsedStr = elapsed > 0 ? ` ${elapsed}s` : "";

	return (
		<box flexDirection="row" gap={1} overflow="hidden">
			<text fg={color} attributes={TextAttributes.BOLD}>
				{SPINNER_FRAMES[frame]}
			</text>
			<text fg={color} attributes={TextAttributes.BOLD}>
				{label}
			</text>
			<text fg="#abadc8" attributes={TextAttributes.DIM}>
				{elapsedStr}
			</text>
		</box>
	);
}
