import { CommandMenu } from "@cli/components/command-menu";
import type { CommandContext } from "@cli/components/command-menu/types";
import { useCommandMenu } from "@cli/components/command-menu/use-command-menu";
import { StatusBar } from "@cli/components/status-bar";
import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import { useCallback, useRef } from "react";

type Props = {
	onSubmit: (value: string) => void;
	commandContext: CommandContext;
	disabled?: boolean;
};

const TEXT_AREA_KEYBINDINGS: KeyBinding[] = [
	{ name: "return", action: "submit" },
	{ name: "enter", action: "submit" },
	{ name: "return", shift: true, action: "newline" },
	{ name: "enter", shift: true, action: "newline" },
];

export function InputBar({ onSubmit, commandContext, disabled }: Props) {
	const textareaRef = useRef<TextareaRenderable | null>(null);

	const {
		showCommandMenu,
		commandMenuQuery,
		selectedCommandIndex,
		scrollRef,
		handleContentChange,
		resolveCommand,
		setSelectedCommandIndex,
	} = useCommandMenu();

	const handleExecute = useCallback(
		async (index: number) => {
			const command = resolveCommand(index);
			if (command?.action) {
				await command.action(commandContext);
				textareaRef.current?.clear();
			}
		},
		[resolveCommand, commandContext],
	);

	const handleTextareaContentChange = useCallback(() => {
		const text = textareaRef.current?.plainText ?? "";
		handleContentChange(text);
	}, [handleContentChange]);

	const handleTextareaSubmit = useCallback(() => {
		if (disabled) return;

		const text = textareaRef.current?.plainText ?? "";
		if (showCommandMenu) {
			void handleExecute(selectedCommandIndex);
			return;
		}

		const trimmed = text.trim();
		if (!trimmed) return;

		onSubmit(trimmed);
		textareaRef.current?.clear();
	}, [disabled, showCommandMenu, selectedCommandIndex, handleExecute, onSubmit]);

	return (
		<box width="100%" flexShrink={0} paddingTop={1}>
			<box
				border
				borderStyle="rounded"
				borderColor={disabled ? "#313244" : "#585b70"}
				backgroundColor="#181825"
				overflow="hidden"
			>
				<box paddingX={2} paddingY={0.5} width="100%" gap={0.5} overflow="hidden">
					{showCommandMenu && (
						<CommandMenu
							query={commandMenuQuery}
							selectedIndex={selectedCommandIndex}
							scrollRef={scrollRef}
							onSelect={setSelectedCommandIndex}
							onExecute={handleExecute}
						/>
					)}
					<textarea
						ref={textareaRef}
						focused={!disabled}
						width="100%"
						height={3}
						placeholder="what would you like to do? (/ for commands)"
						placeholderColor="#585b70"
						textColor="#cdd6f4"
						keyBindings={TEXT_AREA_KEYBINDINGS}
						onContentChange={handleTextareaContentChange}
						onSubmit={handleTextareaSubmit}
					/>
					<StatusBar />
				</box>
			</box>
		</box>
	);
}
