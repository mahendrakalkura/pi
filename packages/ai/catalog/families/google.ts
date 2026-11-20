// Google Gemini and Gemma models.

import type { ThinkingLevelMap } from "../../src/types.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import type { ModelsDevReasoningOption } from "../sources/models-dev.ts";

const GOOGLE_SUPPORTED_THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const GOOGLE_THINKING_KEYS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

/** Gemini effort levels from models.dev, normalized to Google's discrete wire levels, with a Gemma 4 fallback. */
export function googleThinkingLevels(
	modelId: string,
	reasoningOptions: readonly ModelsDevReasoningOption[] = [],
): ThinkingLevelMap | undefined {
	const effortMap = getEffortThinkingLevelMap(reasoningOptions);
	if (effortMap) {
		const normalized: ThinkingLevelMap = { off: effortMap.off };
		let hasSupported = effortMap.off !== null;
		for (const level of GOOGLE_THINKING_KEYS) {
			const mapped = effortMap[level];
			const supported = mapped && GOOGLE_SUPPORTED_THINKING_LEVELS.has(mapped.toLowerCase()) ? mapped : null;
			normalized[level] = supported;
			if (supported !== null) hasSupported = true;
		}
		if (hasSupported) return normalized;
	}
	if (isGemma4Model(modelId)) {
		return { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" };
	}
	return undefined;
}
