import { NIGHTCODE_VERSION } from "@cli/version";
import { TextAttributes } from "@opentui/core";

export function Header() {
	return (
		<box
			justifyContent="center"
			alignItems="center"
			width="100%"
			overflow="hidden"
			flexShrink={0}
			paddingTop={1}
			paddingBottom={0}
		>
			<box flexDirection="row" justifyContent="center" gap={6} alignItems="center">
				<text fg="#b4befe" attributes={TextAttributes.BOLD}>
					{"\u2588\u2584"}
				</text>

				<text fg="#cdd6f4" attributes={TextAttributes.BOLD}>
					Night Code
				</text>

				<text fg="#45475a" attributes={TextAttributes.DIM}>
					{`\u2022 v${NIGHTCODE_VERSION}`}
				</text>
			</box>

			<box width="100%" maxWidth={70} alignItems="center" overflow="hidden"></box>

			<text fg="#313244">{"\u2500".repeat(60)}</text>
		</box>
	);
}
