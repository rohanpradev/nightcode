import { filterCommands } from "@cli/components/command-menu/filter-commands";
import type { CommandItem } from "@cli/components/command-menu/types";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type RefObject, useCallback, useMemo, useRef, useState } from "react";

type UseCommandMenuReturn = {
	showCommandMenu: boolean;
	commandMenuQuery: string;
	selectedCommandIndex: number;
	filteredCommands: CommandItem[];
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	handleContentChange: (value: string) => void;
	resolveCommand: (index: number) => CommandItem | undefined;
	setSelectedCommandIndex: (index: number) => void;
};

export function useCommandMenu(): UseCommandMenuReturn {
	const [textValue, setTextValue] = useState("");
	const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
	const [showCommandMenu, setShowCommandMenu] = useState(false);
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);

	const commandMenuQuery = showCommandMenu && textValue.startsWith("/") ? textValue.slice(1) : "";

	const filteredCommands = useMemo(
		() => (showCommandMenu ? filterCommands(commandMenuQuery) : []),
		[commandMenuQuery, showCommandMenu],
	);

	const handleContentChange = useCallback((value: string) => {
		const shouldShow = /^\/[^\s]*$/.test(value);
		setTextValue(value);
		setShowCommandMenu(shouldShow);
		if (shouldShow) {
			setSelectedCommandIndex(0);
			scrollRef.current?.scrollTo(0);
		}
	}, []);

	const resolveCommand = useCallback(
		(index: number): CommandItem | undefined => {
			if (index < 0 || index >= filteredCommands.length) return undefined;
			const command = filteredCommands[index];
			if (command) {
				setShowCommandMenu(false);
				setTextValue("");
			}
			return command;
		},
		[filteredCommands],
	);

	const scrollCommandIntoView = useCallback(
		(index: number) => {
			const command = filteredCommands[index];
			if (!command) return;
			scrollRef.current?.scrollChildIntoView(`command-${command.name}`);
		},
		[filteredCommands],
	);

	useKeyboard((key) => {
		if (!showCommandMenu) return;

		if (key.name === "escape") {
			key.preventDefault();
			setShowCommandMenu(false);
			return;
		}

		if (filteredCommands.length === 0) return;

		if (key.name === "down" || (key.name === "tab" && !key.shift)) {
			key.preventDefault();
			const nextIndex = (selectedCommandIndex + 1) % filteredCommands.length;
			setSelectedCommandIndex(nextIndex);
			scrollCommandIntoView(nextIndex);
			return;
		}

		if (key.name === "up" || (key.name === "tab" && key.shift)) {
			key.preventDefault();
			const nextIndex =
				selectedCommandIndex === 0 ? filteredCommands.length - 1 : selectedCommandIndex - 1;
			setSelectedCommandIndex(nextIndex);
			scrollCommandIntoView(nextIndex);
		}
	});

	return {
		showCommandMenu,
		commandMenuQuery,
		selectedCommandIndex,
		filteredCommands,
		scrollRef,
		handleContentChange,
		resolveCommand,
		setSelectedCommandIndex,
	};
}
