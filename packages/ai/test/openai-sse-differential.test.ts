import { Stream } from "openai/core/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { iterateOpenAIStream } from "../src/api/openai-sse.ts";

// iterateOpenAIStream() must give what the OpenAI SDK's own Stream gives for the same response bytes, however the bytes
// are split into reads: the same events in the same order, the same error, the same abort of the request.

const encoder = new TextEncoder();

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function chatChunk(i: number, content: string): string {
	return JSON.stringify({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		model: "m",
		choices: [{ index: 0, delta: { content }, finish_reason: null }],
		n: i,
	});
}

const CORPUS: Record<string, string> = {
	lf: [
		`data: ${chatChunk(0, "Hello")}\n\n`,
		`data: ${chatChunk(1, " wörld ✓ 𝄞")}\n\n`,
		`data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n`,
		"data: [DONE]\n\n",
	].join(""),
	crlf: `data: ${chatChunk(0, "a")}\r\n\r\ndata: ${chatChunk(1, "b")}\r\n\r\ndata: [DONE]\r\n\r\n`,
	cr: `data: ${chatChunk(0, "a")}\r\rdata: ${chatChunk(1, "b")}\r\r`,
	mixed: `data: ${chatChunk(0, "a")}\r\n\ndata: ${chatChunk(1, "b")}\n\r\n: keep-alive\r\rdata: ${chatChunk(2, "c")}\n\n`,
	comments: `: ping\n\n:\n\ndata: ${chatChunk(0, "x")}\n: inside\n\n: OPENROUTER PROCESSING\n\n`,
	multiline: `data: {"id":"c",\ndata: "choices":[]}\n\n` + `data:{"no":"space"}\n\n` + `data:  {"two":"spaces"}\n\n`,
	fields: `id: 7\nretry: 100\nevent: response.created\ndata: {"type":"response.created"}\n\nunknown\ndata\n\n`,
	afterDone: `data: ${chatChunk(0, "a")}\n\ndata: [DONE]\n\ndata: ${chatChunk(1, "ignored")}\n\ndata: not json\n\n`,
	doneSuffix: `data: [DONE] trailing\n\ndata: ${chatChunk(0, "ignored")}\n\n`,
	errorField: `data: ${chatChunk(0, "a")}\n\ndata: {"error":{"message":"overloaded","type":"server_error","code":"529"}}\n\ndata: ${chatChunk(1, "b")}\n\n`,
	errorString: `data: {"error":"plain"}\n\n`,
	errorEvent: `event: error\ndata: {"type":"error","code":"x","message":"m"}\n\n`,
	threadEvents: `event: thread.message.delta\ndata: {"id":"t"}\n\nevent: thread.error\ndata: {"x":1}\n\n`,
	threadError: `event: thread.run\ndata: {"id":"r"}\n\nevent: error\ndata: 1\n\n`,
	threadErrorObj: `event: thread.run\ndata: {"id":"r"}\n\n`,
	notJson: `data: ${chatChunk(0, "a")}\n\ndata: {"broken": \n\n`,
	emptyData: `data:\n\ndata: ${chatChunk(0, "a")}\n\n`,
	eventOnly: `event: ping\n\ndata: ${chatChunk(0, "a")}\n\n`,
	unterminated: `data: ${chatChunk(0, "a")}\n\ndata: ${chatChunk(1, "dropped")}`,
	unterminatedLf: `data: ${chatChunk(0, "a")}\n\ndata: ${chatChunk(1, "dropped")}\n`,
	trailingCr: `data: ${chatChunk(0, "a")}\n\r`,
	trailingCrOnly: `data: ${chatChunk(0, "a")}\r`,
	bomStart: `\uFEFFdata: ${chatChunk(0, "a")}\n\n`,
	doubleBom: `\uFEFF\uFEFFdata: ${chatChunk(0, "a")}\n\n`,
	bomLines: `data: ${chatChunk(0, "a")}\n\uFEFF\n\uFEFFdata: ${chatChunk(1, "b")}\n\n`,
	nullData: `data: null\n\ndata: 0\n\ndata: "s"\n\ndata: [1,2]\n\n`,
	empty: "",
	blankLines: "\n\n\n\r\n\r\r",
};

function invalidUtf8Body(): Uint8Array {
	const parts = [
		encoder.encode('data: {"t":"'),
		new Uint8Array([0xe2, 0x82]), // truncated sequence before the end of the line
		encoder.encode('"}\n\ndata: {"u":"'),
		new Uint8Array([0xff, 0xc0, 0x80, 0xf0, 0x9f]),
		encoder.encode('"}\n\ndata: {"v":"\u00e9'),
		new Uint8Array([0xed, 0xa0, 0x80]), // a surrogate encoded in UTF-8
		encoder.encode('"}\n\n'),
	];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function fuzzBody(random: () => number): string {
	const newlines = ["\n", "\r\n", "\r"];
	const nl = () => newlines[Math.floor(random() * newlines.length)];
	let body = random() < 0.1 ? "\uFEFF" : "";
	const count = 1 + Math.floor(random() * 6);
	for (let i = 0; i < count; i++) {
		const roll = random();
		if (roll < 0.1) body += `: comment ${i}${nl()}`;
		if (roll > 0.8) body += `event: ${random() < 0.3 ? "thread.x" : "message"}${nl()}`;
		const kind = random();
		if (kind < 0.15) {
			body += `data: {"a":${i},${nl()}data: "b":"${"é∑𝄞".repeat(i)}"}${nl()}`;
		} else if (kind < 0.2) {
			body += `data: [DONE]${nl()}`;
		} else if (kind < 0.25) {
			body += `data: {"error":{"message":"e${i}"}}${nl()}`;
		} else {
			body += `data: ${chatChunk(i, "x".repeat(Math.floor(random() * 40)))}${nl()}`;
		}
		if (random() < 0.9 || i < count - 1) body += nl();
	}
	return body;
}

function splitAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	let start = 0;
	for (const cut of [...cuts].sort((a, b) => a - b)) {
		chunks.push(bytes.slice(start, cut));
		start = cut;
	}
	chunks.push(bytes.slice(start));
	return chunks;
}

function streamOf(
	chunks: Uint8Array[],
	abort?: { signal: AbortSignal; after: number; hang?: boolean; abortNow: () => void },
): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (abort && index >= abort.after) {
				// What fetch does when its signal aborts: the body errors with an AbortError. With `hang`, a body that
				// ignores the abort: only cancelling it ends a read.
				return new Promise<void>((resolve) => {
					// The request is aborted while the body waits for the network.
					setTimeout(abort.abortNow, 1);
					if (abort.hang) return;
					const fail = () => {
						controller.error(new DOMException("This operation was aborted", "AbortError"));
						resolve();
					};
					if (abort.signal.aborted) fail();
					else abort.signal.addEventListener("abort", fail, { once: true });
				});
			}
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(chunks[index++]);
		},
	});
}

interface Outcome {
	events: unknown[];
	error?: { name: string; message: string; status?: unknown; error?: unknown; headers?: unknown };
	aborted: boolean;
	logged: unknown[][];
}

async function run(chunks: Uint8Array[], useNew: boolean, options: RunOptions = {}): Promise<Outcome> {
	const controller = new AbortController();
	const body = streamOf(
		chunks,
		options.abortAfter === undefined
			? undefined
			: {
					signal: controller.signal,
					after: options.abortAfter,
					hang: options.hang,
					abortNow: () => controller.abort(),
				},
	);
	const response = new Response(body, { headers: { "x-request-id": "req_1" } });
	const logged: unknown[][] = [];
	const client = options.logLevel
		? {
				logLevel: options.logLevel,
				logger: {
					error: (...args: unknown[]) => logged.push(["client", ...args]),
					warn: () => {},
					info: () => {},
					debug: () => {},
				},
			}
		: undefined;
	const stream = Stream.fromSSEResponse<unknown>(response, controller, client as never);
	const iterable = useNew ? iterateOpenAIStream(stream, response, client) : stream;
	const events: unknown[] = [];
	const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		logged.push(args);
	});
	let error: Outcome["error"];
	try {
		for await (const event of iterable) {
			events.push(event);
			if (options.abortAfter !== undefined && events.length === 1) controller.abort();
			if (options.breakAfter !== undefined && events.length >= options.breakAfter) break;
		}
	} catch (caught) {
		const e = caught as { name: string; message: string; status?: unknown; error?: unknown; headers?: Headers };
		error = {
			name: e.constructor.name,
			message: e.message,
			status: e.status,
			error: e.error,
			headers: e.headers ? [...e.headers] : e.headers,
		};
	} finally {
		spy.mockRestore();
	}
	return { events, error, aborted: controller.signal.aborted, logged };
}

interface RunOptions {
	breakAfter?: number;
	abortAfter?: number;
	hang?: boolean;
	logLevel?: "off" | "error" | "warn";
}

async function expectSame(chunks: Uint8Array[], options?: RunOptions): Promise<void> {
	const expected = await run(chunks, false, options);
	const actual = await run(chunks, true, options);
	expect(actual).toEqual(expected);
}

describe("iterateOpenAIStream matches the OpenAI SDK's Stream", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const [name, text] of Object.entries(CORPUS)) {
		it(`${name}: split at every byte boundary, one byte per read, one read`, async () => {
			const bytes = encoder.encode(text);
			await expectSame([bytes]);
			await expectSame(
				splitAt(
					bytes,
					Array.from({ length: Math.max(0, bytes.length - 1) }, (_, i) => i + 1),
				),
			);
			for (let cut = 0; cut <= bytes.length; cut++) {
				await expectSame(splitAt(bytes, [cut]));
			}
		});
	}

	it("invalid UTF-8, split at every byte boundary", async () => {
		const bytes = invalidUtf8Body();
		await expectSame([bytes]);
		for (let cut = 0; cut <= bytes.length; cut++) {
			await expectSame(splitAt(bytes, [cut]));
		}
	});

	it("fuzzed streams split into random reads", async () => {
		const random = rng(0x5eed);
		for (let round = 0; round < 400; round++) {
			const bytes = encoder.encode(fuzzBody(random));
			const cuts = Array.from({ length: Math.floor(random() * 8) }, () => Math.floor(random() * (bytes.length + 1)));
			await expectSame(splitAt(bytes, cuts));
		}
	});

	it("a consumer that stops early aborts the request, as the SDK does", async () => {
		const bytes = encoder.encode(CORPUS.lf);
		for (let cut = 0; cut <= bytes.length; cut += 7) {
			const outcome = await run(splitAt(bytes, [cut]), true, { breakAfter: 1 });
			expect(outcome.aborted).toBe(true);
			await expectSame(splitAt(bytes, [cut]), { breakAfter: 1 });
			await expectSame(splitAt(bytes, [cut]), { breakAfter: 2 });
		}
	});

	it("an aborted request ends the events without an error, as the SDK does", async () => {
		const bytes = encoder.encode(CORPUS.lf);
		for (let after = 1; after <= 4; after++) {
			const chunks = splitAt(bytes, [40, 120, 200]);
			const outcome = await run(chunks, true, { abortAfter: after });
			expect(outcome.error).toBeUndefined();
			await expectSame(chunks, { abortAfter: after });
		}
	});

	it("an aborted request whose body ignores the abort ends too, as the SDK's does", async () => {
		const bytes = encoder.encode(CORPUS.lf);
		for (let after = 1; after <= 4; after++) {
			const chunks = splitAt(bytes, [40, 120, 200]);
			const outcome = await run(chunks, true, { abortAfter: after, hang: true });
			expect(outcome.error).toBeUndefined();
			await expectSame(chunks, { abortAfter: after, hang: true });
		}
	});

	it("data that is not JSON is logged through the client's logger at its level", async () => {
		const bytes = encoder.encode(CORPUS.notJson);
		for (const logLevel of ["off", "error", "warn"] as const) {
			await expectSame([bytes], { logLevel });
		}
	});

	it("passes through an iterable that is not the SDK's Stream", async () => {
		const events = [{ a: 1 }, { b: 2 }];
		const iterable = {
			async *[Symbol.asyncIterator]() {
				yield* events;
			},
		};
		const seen: unknown[] = [];
		for await (const event of iterateOpenAIStream(iterable, new Response("data: {}\n\n"))) seen.push(event);
		expect(seen).toEqual(events);
	});
});
