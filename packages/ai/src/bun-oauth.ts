import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";

/**
 * Register OAuth flows embedded in the standalone Bun binary. Each is loaded when it is first used, as in every other build:
 * the imports are written out for the binary's bundler to follow, and what the flows need (node:http callback servers,
 * node:crypto) is not loaded at every start.
 */
export function registerBunOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: async () => (await import("./auth/oauth/anthropic.ts")).anthropicOAuth,
		openaiCodex: async () => (await import("./auth/oauth/openai-codex.ts")).openaiCodexOAuth,
		openaiChatGPT: async () => (await import("./auth/oauth/openai-chatgpt.ts")).openaiChatGPTOAuth,
		githubCopilot: async () => (await import("./auth/oauth/github-copilot.ts")).githubCopilotOAuth,
		openrouter: async () => (await import("./auth/oauth/openrouter.ts")).openRouterOAuth,
		kimiCoding: async () => (await import("./auth/oauth/kimi-coding.ts")).kimiCodingOAuth,
		meta: async () => (await import("./auth/oauth/meta.ts")).metaOAuth,
		xai: async () => (await import("./auth/oauth/xai.ts")).xaiOAuth,
		radius: async (options) => (await import("./auth/oauth/radius.ts")).createRadiusOAuth(options),
	});
}
