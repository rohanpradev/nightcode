export * from "./agent-runtime";

import { createLLMService } from "./agent-runtime";

/**
 * Backwards-compatible embedded runtime. New callers should create a scoped
 * service with createLLMService so workspace, approvals, plans, and traces do
 * not leak across sessions.
 */
export const llm = createLLMService();
