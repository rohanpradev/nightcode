import { Spinner } from "@cli/components/spinner";
import type { LLMMessage, LLMProvider, PendingApproval } from "@cli/services/llm";
import { formatToolArgs, type ToolActivity } from "@cli/services/tool-activity";
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import type { RefObject } from "react";

type ConversationPaneProps = {
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	messages: LLMMessage[];
	isLoading: boolean;
	streamingText: string;
	toolActivities: ToolActivity[];
	pendingApprovals: PendingApproval[];
	model: string;
	provider: LLMProvider;
	agentMode: boolean;
	workspaceRoot: string;
	getMessageKey: (message: LLMMessage) => string;
};

export function ConversationPane({
	scrollRef,
	messages,
	isLoading,
	streamingText,
	toolActivities,
	pendingApprovals,
	model,
	provider,
	agentMode,
	workspaceRoot,
	getMessageKey,
}: ConversationPaneProps) {
	return (
		<scrollbox
			ref={scrollRef}
			flexGrow={1}
			flexShrink={1}
			overflow="hidden"
			stickyScroll
			stickyStart="bottom"
			viewportCulling
			paddingBottom={1}
		>
			{!messages.length && !isLoading && (
				<box justifyContent="center" alignItems="center" paddingY={2} gap={1}>
					<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
						{"\u2726 Night Code"}
					</text>
					<text fg="#6c7086">{"Terminal-first AI coding agent"}</text>
					<box paddingTop={1} gap={0.5} alignItems="center">
						<box flexDirection="row" gap={1}>
							<text fg="#585670">{"\u2022"}</text>
							<text fg="#abadc8">{"Type a message to start coding"}</text>
						</box>
						<box flexDirection="row" gap={1}>
							<text fg="#585670">{"\u2022"}</text>
							<text fg="#abadc8">{"Use"}</text>
							<text fg="#89b4fa" attributes={TextAttributes.BOLD}>
								{"/"}
							</text>
							<text fg="#abadc8">{" for commands"}</text>
						</box>
						<box flexDirection="row" gap={1}>
							<text fg="#585670">{"\u2022"}</text>
							<text fg="#abadc8">{`${model} via ${provider}`}</text>
							<text fg={agentMode ? "#a6e3a1" : "#585678"}>{agentMode ? " \u26a1" : ""}</text>
						</box>
						<box flexDirection="row" gap={1} overflow="hidden">
							<text fg="#585670">{"\u2022"}</text>
							<text fg="#abadc8">{`Workspace: ${workspaceRoot}`}</text>
						</box>
					</box>
				</box>
			)}

			{messages.map((msg) => (
				<box key={getMessageKey(msg)} overflow="hidden">
					{msg.role === "user" && (
						<box overflow="hidden" paddingLeft={1}>
							<box flexDirection="row" gap={1}>
								<text fg="#74c7ec" attributes={TextAttributes.BOLD}>
									{"\u276f"}
								</text>
								<text fg="#74c7ec" attributes={TextAttributes.BOLD}>
									You
								</text>
							</box>
							<box paddingLeft={3} overflow="hidden">
								<text fg="#cdd6f4">{msg.content}</text>
							</box>
						</box>
					)}

					{msg.role === "assistant" && (
						<box overflow="hidden" flexDirection="row" paddingY={0.5} marginLeft={1}>
							<box width={0} border={["left"]} borderColor="#cba6f7" borderStyle="heavy" />
							<box paddingLeft={1} overflow="hidden">
								<box flexDirection="row" gap={1} paddingBottom={0.5}>
									<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
										{"\u2726"}
									</text>
									<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
										Night Code
									</text>
								</box>
								<text fg="#cdd6f4">{msg.content}</text>
							</box>
						</box>
					)}

					{(msg.role === "system" || msg.role === "notice") && (
						<box flexDirection="row" gap={1} paddingLeft={2} overflow="hidden">
							<text fg="#45475a">{"\u2500"}</text>
							<text fg="#6c7086" attributes={TextAttributes.DIM}>
								{msg.content}
							</text>
						</box>
					)}
				</box>
			))}

			{pendingApprovals.length > 0 && (
				<box marginLeft={1} paddingLeft={1} border={["left"]} borderColor="#f9e2af" gap={0.5}>
					<text fg="#f9e2af" attributes={TextAttributes.BOLD}>
						{`${pendingApprovals.length} action${pendingApprovals.length === 1 ? "" : "s"} need approval`}
					</text>
					{pendingApprovals.map((approval) => (
						<box key={approval.id} gap={0} overflow="hidden">
							<text fg="#89b4fa">{`${approval.toolName}  ${approval.id}`}</text>
							<text fg="#6c7086" attributes={TextAttributes.DIM}>
								{`/approve ${approval.id}   /deny ${approval.id}`}
							</text>
						</box>
					))}
				</box>
			)}

			{isLoading && streamingText && (
				<box
					overflow="hidden"
					paddingBottom={0.5}
					flexDirection="row"
					paddingY={0.5}
					marginLeft={1}
				>
					<box width={0} border={["left"]} borderColor="#89b4fa" borderStyle="heavy" />
					<box paddingLeft={1} overflow="hidden">
						<box flexDirection="row" gap={1} paddingBottom={0.5}>
							<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
								{"\u2726"}
							</text>
							<text fg="#cba6f7" attributes={TextAttributes.BOLD}>
								Night Code
							</text>
							<text fg="#f9e2af" attributes={TextAttributes.DIM}>
								{"\u2022 streaming"}
							</text>
						</box>

						{toolActivities.length > 0 && (
							<box paddingBottom={0.5} gap={0}>
								{toolActivities.map((activity) => (
									<ToolActivityRow key={`tool-${activity.id}`} activity={activity} />
								))}
							</box>
						)}

						<box overflow="hidden">
							<text fg="#a6adc8">{streamingText}</text>
						</box>
					</box>
				</box>
			)}

			{isLoading && !streamingText && (
				<box paddingLeft={2} paddingY={0.5}>
					<Spinner
						label={
							toolActivities.length > 0
								? `${toolActivities[toolActivities.length - 1]?.name}`
								: "Thinking"
						}
						color="#cba6f7"
					/>
					{toolActivities.length > 0 && (
						<box paddingLeft={3} paddingTop={0.5} gap={0}>
							{toolActivities.map((activity) => (
								<ToolActivityRow
									key={`tool-wait-${activity.id}`}
									activity={activity}
									emphasizeName
								/>
							))}
						</box>
					)}
				</box>
			)}
		</scrollbox>
	);
}

function ToolActivityRow({
	activity,
	emphasizeName = false,
}: {
	activity: ToolActivity;
	emphasizeName?: boolean;
}) {
	return (
		<box flexDirection="row" gap={1} overflow="hidden">
			<text fg={activity.result ? "#a6e3a1" : "#f9e2af"}>
				{activity.result ? "\u2713" : "\u25cb"}
			</text>
			<text fg="#89b4fa" attributes={emphasizeName ? TextAttributes.BOLD : undefined}>
				{activity.name}
			</text>
			<text fg="#585b70" attributes={TextAttributes.DIM}>
				{formatToolArgs(activity)}
			</text>
			{activity.durationMs != null && (
				<text fg="#45475a" attributes={TextAttributes.DIM}>
					{`${activity.durationMs}ms`}
				</text>
			)}
		</box>
	);
}
