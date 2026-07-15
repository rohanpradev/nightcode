import { CommandMenu } from "@cli/components/command-menu";
import type { CommandContext } from "@cli/components/command-menu/types";
import { useCommandMenu } from "@cli/components/command-menu/use-command-menu";
import { StatusBar } from "@cli/components/status-bar";
import type { EditorTraits, KeyBinding, KeyEvent, TextareaRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
	onSubmit: (value: string) => void;
	commandContext: CommandContext;
	disabled?: boolean;
	vimMode?: boolean;
};

export type VimInputMode = "insert" | "normal";

const TEXT_AREA_KEYBINDINGS: KeyBinding[] = [
	{ name: "return", action: "submit" },
	{ name: "enter", action: "submit" },
	{ name: "return", shift: true, action: "newline" },
	{ name: "enter", shift: true, action: "newline" },
];

export function InputBar({ onSubmit, commandContext, disabled, vimMode = false }: Props) {
	const textareaRef = useRef<TextareaRenderable | null>(null);
	const [vimInputMode, setVimInputMode] = useState<VimInputMode>("insert");

	const {
		showCommandMenu,
		commandMenuQuery,
		selectedCommandIndex,
		scrollRef,
		handleContentChange,
		resolveCommand,
		setSelectedCommandIndex,
	} = useCommandMenu();

	useEffect(() => {
		if (!textareaRef.current) return;

		textareaRef.current.traits = {
			capture: ["escape", "submit", "tab"],
			status: showCommandMenu ? "Command palette" : "Composing",
		} satisfies EditorTraits;

		return () => {
			if (textareaRef.current) textareaRef.current.traits = {};
		};
	}, [showCommandMenu]);

	useEffect(() => {
		setVimInputMode(vimMode ? "normal" : "insert");
	}, [vimMode]);

	const handleVimKeyDown = useCallback(
		(event: KeyEvent) => {
			if (!vimMode || showCommandMenu) return;

			if (vimInputMode === "insert") {
				if (event.name === "escape") {
					event.preventDefault();
					event.stopPropagation();
					setVimInputMode("normal");
				}
				return;
			}

			// Preserve application-level shortcuts such as Ctrl+C/Ctrl+D.
			if (event.ctrl && event.name !== "r") return;

			const editor = textareaRef.current;
			if (!editor) return;

			event.preventDefault();
			event.stopPropagation();

			if (event.name === "i") {
				if (event.shift) editor.gotoLineHome();
				setVimInputMode("insert");
				return;
			}
			if (event.name === "a") {
				if (event.shift) editor.gotoLineEnd();
				else editor.moveCursorRight();
				setVimInputMode("insert");
				return;
			}
			if (event.name === "o") {
				editor.gotoLineEnd();
				editor.newLine();
				setVimInputMode("insert");
				return;
			}

			switch (event.name) {
				case "h":
				case "backspace":
					editor.moveCursorLeft();
					break;
				case "j":
					editor.moveCursorDown();
					break;
				case "k":
					editor.moveCursorUp();
					break;
				case "l":
					editor.moveCursorRight();
					break;
				case "w":
					editor.moveWordForward();
					break;
				case "b":
					editor.moveWordBackward();
					break;
				case "0":
				case "home":
					editor.gotoLineHome();
					break;
				case "$":
				case "end":
					editor.gotoLineEnd();
					break;
				case "x":
				case "delete":
					editor.deleteChar();
					break;
				case "u":
					editor.undo();
					break;
				case "r":
					if (event.ctrl) editor.redo();
					break;
				case "escape":
					break;
			}
		},
		[showCommandMenu, vimInputMode, vimMode],
	);

	const handleExecute = useCallback(
		async (index: number) => {
			const command = resolveCommand(index);
			if (!command) return;

			if (command.inputTemplate) {
				textareaRef.current?.setText(command.inputTemplate);
				if (textareaRef.current) {
					textareaRef.current.cursorOffset = command.inputTemplate.length;
					textareaRef.current.focus();
				}
				return;
			}

			if (command.action) {
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
		const text = textareaRef.current?.plainText ?? "";
		if (disabled && text.trim() !== "/stop") return;
		if (showCommandMenu) {
			void handleExecute(selectedCommandIndex);
			return;
		}

		const trimmed = text.trim();
		if (!trimmed) return;

		onSubmit(trimmed);
		textareaRef.current?.clear();
		if (vimMode) setVimInputMode("normal");
	}, [disabled, showCommandMenu, selectedCommandIndex, handleExecute, onSubmit, vimMode]);

	return (
		<box width="100%" flexShrink={0} paddingTop={1}>
			<box
				border
				borderStyle="rounded"
				borderColor={disabled ? "#f9e2af" : "#585b70"}
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
						focused
						width="100%"
						height={3}
						placeholder={
							disabled
								? "agent running — /stop to cancel"
								: "what would you like to do? (/ for commands)"
						}
						placeholderColor="#585b70"
						textColor="#cdd6f4"
						wrapMode="word"
						keyBindings={TEXT_AREA_KEYBINDINGS}
						onKeyDown={handleVimKeyDown}
						onContentChange={handleTextareaContentChange}
						onSubmit={handleTextareaSubmit}
					/>
					<StatusBar vimInputMode={vimMode ? vimInputMode : undefined} />
				</box>
			</box>
		</box>
	);
}
