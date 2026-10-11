import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAzureResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// The OpenAI providers read their streams with iterateOpenAIStream(). Run each provider on the same response bytes twice,
// once that way and once iterating the SDK's Stream as before, through a real SDK client: the events and the final
// message must be the same.

const mode = vi.hoisted(() => ({ sdk: false, fastPathRuns: 0 }));

vi.mock("../src/api/openai-sse.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/api/openai-sse.ts")>();
	return {
		iterateOpenAIStream: <T>(stream: AsyncIterable<T>, response: Response, client?: never) => {
			if (mode.sdk) return stream;
			mode.fastPathRuns++;
			return actual.iterateOpenAIStream(stream, response, client);
		},
	};
});

const encoder = new TextEncoder();

function sseFetch(body: string, readSize: number, status = 200): typeof fetch {
	return (async () => {
		const bytes = encoder.encode(body);
		let offset = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.length) {
					controller.close();
					return;
				}
				controller.enqueue(bytes.slice(offset, offset + readSize));
				offset += readSize;
			},
		});
		return new Response(stream, { status, headers: { "content-type": "text/event-stream", "x-request-id": "r1" } });
	}) as unknown as typeof fetch;
}

const completionsModel: Model<"openai-completions"> = {
	id: "fake-model",
	name: "Fake",
	api: "openai-completions",
	provider: "fake",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const responsesModel: Model<"openai-responses"> = {
	...completionsModel,
	api: "openai-responses",
	provider: "openai",
} as Model<"openai-responses">;

const azureModel: Model<"azure-openai-responses"> = {
	...completionsModel,
	api: "azure-openai-responses",
	provider: "azure-openai-responses",
	baseUrl: "https://fake.openai.azure.com/openai/v1",
} as Model<"azure-openai-responses">;

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ id: "chatcmpl-1", model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
}

const args = JSON.stringify({ path: "src/a.ts", content: 'line "one"\nline \\two\\ ✓\n'.repeat(20) });
const argPieces = args.match(/.{1,16}/gs) ?? [];

const COMPLETIONS: Record<string, string> = {
	text: [
		": OPENROUTER PROCESSING\n\n",
		chunk({ role: "assistant", content: "" }),
		chunk({ reasoning_content: "Let me think" }),
		chunk({ reasoning_content: " about it." }),
		chunk({ content: "Hello" }),
		chunk({ content: " wörld 𝄞" }),
		chunk({}, "stop"),
		`data: ${JSON.stringify({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } })}\n\n`,
		"data: [DONE]\n\n",
	].join(""),
	toolCall: [
		chunk({
			role: "assistant",
			tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: "" } }],
		}),
		...argPieces.map((piece) => chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] })),
		chunk({}, "tool_calls", { prompt_tokens: 3, completion_tokens: 2 }),
		"data: [DONE]\n\n",
	].join(""),
	crlf: `${chunk({ content: "a" }).replace(/\n/g, "\r\n")}${chunk({}, "stop").replace(/\n/g, "\r\n")}data: [DONE]\r\n\r\n`,
	errorMidStream: `${chunk({ content: "partial" })}data: {"error":{"message":"upstream overloaded","code":529}}\n\n${chunk({}, "stop")}`,
	noFinishReason: `${chunk({ content: "cut" })}data: [DONE]\n\n`,
	notJson: `${chunk({ content: "a" })}data: {not json\n\n`,
	noDone: `${chunk({ content: "a" })}${chunk({}, "stop")}`,
	unterminated: `${chunk({ content: "a" })}data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
	afterDone: `${chunk({ content: "a" })}${chunk({}, "stop")}data: [DONE]\n\n${chunk({ content: "ignored" })}`,
};

function responsesEvent(event: Record<string, unknown>): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const responseBody = { id: "resp_1", object: "response", model: "fake-model", status: "completed", output: [] };
const RESPONSES: Record<string, string> = {
	text: [
		responsesEvent({ type: "response.created", response: { ...responseBody, status: "in_progress" } }),
		responsesEvent({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		}),
		responsesEvent({
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		}),
		responsesEvent({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hi" }),
		responsesEvent({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: " there ✓" }),
		responsesEvent({
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hi there ✓", annotations: [] }],
			},
		}),
		responsesEvent({
			type: "response.completed",
			response: {
				...responseBody,
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		}),
	].join(""),
	errorEvent: `${responsesEvent({ type: "response.created", response: responseBody })}event: error\ndata: {"type":"error","code":"server_error","message":"boom"}\n\n`,
	failed: responsesEvent({
		type: "response.failed",
		response: { ...responseBody, status: "failed", error: { code: "server_error", message: "failed upstream" } },
	}),
	truncated: responsesEvent({ type: "response.created", response: responseBody }),
};

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<unknown[]> {
	const seen: unknown[] = [];
	for await (const event of events) {
		// The partial message is the same object throughout; compare what it was at each event.
		seen.push(
			JSON.parse(JSON.stringify(event, (key, value) => (key === "timestamp" || key === "durationMs" ? 0 : value))),
		);
	}
	return seen;
}

async function both(run: () => AsyncIterable<AssistantMessageEvent>, readsStream = true): Promise<void> {
	mode.sdk = true;
	const expected = await collect(run());
	mode.sdk = false;
	const before = mode.fastPathRuns;
	const actual = await collect(run());
	expect(mode.fastPathRuns).toBe(readsStream ? before + 1 : before);
	expect(actual).toEqual(expected);
}

describe("OpenAI providers read the same events from a stream as the SDK's Stream gives", () => {
	beforeEach(() => {
		mode.sdk = false;
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	for (const [name, body] of Object.entries(COMPLETIONS)) {
		it(`openai-completions: ${name}`, async () => {
			for (const readSize of [1, 7, 64, 100_000]) {
				await both(() =>
					streamCompletions(completionsModel, context, {
						apiKey: "k",
						fetch: sseFetch(body, readSize),
						maxRetries: 0,
					}),
				);
			}
		});
	}

	for (const [name, body] of Object.entries(RESPONSES)) {
		it(`openai-responses: ${name}`, async () => {
			for (const readSize of [1, 13, 100_000]) {
				await both(() =>
					streamResponses(responsesModel, context, {
						apiKey: "sk-k",
						fetch: sseFetch(body, readSize),
						maxRetries: 0,
					}),
				);
			}
		});

		it(`azure-openai-responses: ${name}`, async () => {
			for (const readSize of [1, 100_000]) {
				await both(() =>
					streamAzureResponses(azureModel, context, {
						apiKey: "k",
						fetch: sseFetch(body, readSize),
						maxRetries: 0,
					}),
				);
			}
		});
	}

	it("openai-completions: an HTTP error is reported as before", async () => {
		await both(
			() =>
				streamCompletions(completionsModel, context, {
					apiKey: "k",
					fetch: sseFetch('{"error":{"message":"bad key"}}', 100, 401),
					maxRetries: 0,
				}),
			false,
		);
	});
});
