import { filterCommands } from "@cli/components/command-menu/filter-commands";
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import type { RefObject } from "react";

const MAX_VISIBLE_ITEMS = 8;

type CommandMenuProps = {
	query: string;
	selectedIndex: number;
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	onSelect: (index: number) => void;
	onExecute: (index: number) => void | Promise<void>;
};

export function CommandMenu({
	query,
	selectedIndex,
	scrollRef,
	onSelect,
	onExecute,
}: CommandMenuProps) {
	const filteredCommands = filterCommands(query);

	if (filteredCommands.length === 0) {
		return (
			<text fg="#6c7086" attributes={TextAttributes.ITALIC}>
				No matching commands.
			</text>
		);
	}

	// Clamp selection to valid range
	const safeIndex = Math.min(Math.max(0, selectedIndex), filteredCommands.length - 1);

	// Compute column width once from the filtered set
	const colWidth = Math.max(...filteredCommands.map((c) => c.name.length)) + 4;

	return (
		<>
			<box flexDirection="row" gap={1} paddingBottom={0.5}>
				<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
					{"\u2726"} Commands
				</text>
				<text fg="#585b70" attributes={TextAttributes.DIM}>
					{query && `\u00b7 "${query}"`}
				</text>
			</box>

			<scrollbox
				ref={scrollRef}
				height={Math.min(filteredCommands.length, MAX_VISIBLE_ITEMS)}
				overflow="hidden"
			>
				{filteredCommands.map((cmd, index) => {
					const isSelected = index === safeIndex;
					return (
						// biome-ignore lint/a11y/noStaticElementInteractions: Terminal UI component, n/a
						<box
							key={cmd.value}
							flexDirection="row"
							paddingX={1}
							gap={1}
							overflow="hidden"
							backgroundColor={isSelected ? "#1e1e2e" : undefined}
							onMouseMove={() => onSelect(index)}
							onMouseDown={() => onExecute(index)}
						>
							<text
								selectable={false}
								fg={isSelected ? "#cba6f7" : "#45475a"}
								attributes={TextAttributes.BOLD}
							>
								{isSelected ? "\u276f" : ""}
							</text>

							<box width={colWidth} flexShrink={0}>
								<text
									selectable={false}
									fg={isSelected ? "#cba6f7" : "#b4befe"}
									attributes={isSelected ? TextAttributes.BOLD : undefined}
								>
									{cmd.name}
								</text>
							</box>

							<box flexShrink={1} flexGrow={1} overflow="hidden">
								<text selectable={false} fg={isSelected ? "#cdd6f4" : "#6c7086"}>
									{cmd.description}
								</text>
							</box>

							{cmd.shortcut && (
								<box flexShrink={0}>
									<text selectable={false} fg="#45475a" attributes={TextAttributes.DIM}>
										{cmd.shortcut}
									</text>
								</box>
							)}
						</box>
					);
				})}
			</scrollbox>
		</>
	);
}
