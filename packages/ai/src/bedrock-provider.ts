import { lazyApi } from "./api/lazy.ts";

// Loaded on its first use, as Bedrock is everywhere else: the AWS SDK it is made of is large, and brings Node's http, https,
// net and tls with it, which a start of Pi otherwise has no use for. (The import is written out for the Bun binary's bundler
// to follow, unlike bedrock-converse-stream.lazy.ts's.)
export const bedrockProviderModule = lazyApi(async () => {
	const { stream, streamSimple } = await import("./api/bedrock-converse-stream.ts");
	return { stream, streamSimple };
});
