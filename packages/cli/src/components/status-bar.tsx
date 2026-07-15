import { llm } from "@cli/services/llm";
import { TextAttributes } from "@opentui/core";

type Props = {
	vimInputMode?: "insert" | "normal";
};

export function StatusBar({ vimInputMode }: Props) {
	const { provider, model, agentMode } = llm.config;

	return (
		<box flexDirection="row" gap={1} justifyContent="space-between" overflow="hidden" width="100%">
			<box flexDirection="row" gap={1} flexShrink={0}>
				<text fg={agentMode ? "#a6e3a1" : "#f9e2af"} attributes={TextAttributes.BOLD}>
					{agentMode ? "\u25c9" : "\u25cb"}
				</text>
				<text fg="#bac2de" attributes={TextAttributes.BOLD}>
					{model}
				</text>
				<text fg="#45475a">{"\u2666"}</text>
				<text fg="#585b70">{provider}</text>
				<text fg="#45475a">{"\u2666"}</text>
				<text fg={agentMode ? "#a6e3a1" : "#585b70"}>{agentMode ? "\u26a1 agent" : "chat"}</text>
			</box>

			<box flexDirection="row" gap={1} flexShrink={1} overflow="hidden">
				{vimInputMode && (
					<text fg={vimInputMode === "normal" ? "#f9e2af" : "#a6e3a1"}>
						{`vim:${vimInputMode}`}
					</text>
				)}
				<text fg="#45475a" attributes={TextAttributes.DIM}>
					{"/cmds"}
				</text>
				<text fg="#45475a" attributes={TextAttributes.DIM}>
					{"\u2666"}
				</text>
				<text fg="#45475a" attributes={TextAttributes.DIM}>
					{"\u21b5 send"}
				</text>
			</box>
		</box>
	);
}
