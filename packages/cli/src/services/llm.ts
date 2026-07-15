export type {
	AgentTaskPlan,
	AgentTaskPlanItem,
	LLMConfig,
	LLMMessage,
	LLMProvider,
	LLMService,
	LLMStreamChunk,
	PendingApproval,
} from "@nightcode/server/services/llm";

import { createLLMService } from "@nightcode/server/services/llm";

// The embedded CLI owns its runtime. Importing the server package must not bind
// the UI to the HTTP server's process-wide compatibility singleton.
export const llm = createLLMService({ workspaceRoot: process.cwd() });
