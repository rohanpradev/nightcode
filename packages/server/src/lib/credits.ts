import { findSupportedChatModel, type SupportedProvider } from "@nightcode/shared";

import type { LanguageModelUsage } from "ai";

export function calculateCreditsForUsage({
	provider,
	model,
	usage,
}: {
	provider: SupportedProvider;
	model: string;
	usage: LanguageModelUsage;
}) {
	const definition = findSupportedChatModel(model);
	if (!definition?.pricing) return { credits: 0, provider };

	const inputCost =
		((usage.inputTokens ?? 0) / 1_000_000) * definition.pricing.inputUsdPerMillionTokens;

	const outputCost =
		((usage.outputTokens ?? 0) / 1_000_000) * definition.pricing.outputUsdPerMillionTokens;

	// 1 credit = $0.01
	const credits = Math.ceil((inputCost + outputCost) * 100);

	return { credits, inputCost, outputCost, provider };
}
