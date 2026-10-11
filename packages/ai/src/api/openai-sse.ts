import type OpenAI from "openai";
import { APIError } from "openai/core/error";
import { Stream } from "openai/core/streaming";
import { createSseDecoder, decodeSseText, type ServerSentEvent } from "../utils/sse.ts";

function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(("name" in error && error.name === "AbortError") ||
			("message" in error && String(error.message).includes("FetchRequestCanceledException")))
	);
}

const LOG_LEVELS: Record<string, number> = { off: 0, error: 200, warn: 300, info: 400, debug: 500 };

/** Logs an error as the SDK does: through the client's logger when its level lets errors through, else to the console. */
function logError(client: Pick<OpenAI, "logger" | "logLevel"> | undefined, message: string): void {
	if (!client) {
		console.error(message);
		return;
	}
	const level = LOG_LEVELS[client.logLevel ?? "off"];
	if (client.logger && level !== undefined && level >= LOG_LEVELS.error) {
		client.logger.error(message);
	}
}

/**
 * The server-sent events of a response body, read as the OpenAI SDK reads them (openai/core/streaming, _iterSSEMessages):
 * every line decoded on its own (a byte order mark at the start of any line is dropped), the reads stopped and the body
 * cancelled as soon as `signal` aborts, and the body cancelled when the iteration stops before its end.
 */
async function* iterateOpenAISseMessages(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	// The byte order mark is removed from every line (stripLineBom), so the decoder must keep it.
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	const state = createSseDecoder({ stripLineBom: true });
	let closed = false;
	let failed = false;
	let cancellation: Promise<void> | undefined;
	const cancel = (): Promise<void> | undefined => {
		if (closed || cancellation) return cancellation;
		cancellation = reader.cancel();
		cancellation.catch(() => undefined);
		return cancellation;
	};
	// A pending read ends (done) when the body is cancelled.
	const onAbort = () => queueMicrotask(() => void cancel());
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();

	try {
		while (true) {
			if (signal.aborted) return;
			let result: Awaited<ReturnType<typeof reader.read>>;
			try {
				result = await reader.read();
			} catch (error) {
				if (signal.aborted && (isAbortError(error) || error === signal.reason)) return;
				throw error;
			}
			if (signal.aborted) return;
			if (result.done) {
				closed = true;
				break;
			}
			for (const event of decodeSseText(state, decoder.decode(result.value, { stream: true }), false)) {
				if (signal.aborted) return;
				yield event;
			}
		}
		for (const event of decodeSseText(state, decoder.decode(), true)) {
			if (signal.aborted) return;
			yield event;
		}
	} catch (error) {
		failed = true;
		if (!signal.aborted || (!isAbortError(error) && error !== signal.reason)) throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (!closed) {
			const pending = cancel();
			if (pending && !failed && !signal.aborted) await pending;
		}
		reader.releaseLock();
	}
}

function parseEventData(data: string, client: Pick<OpenAI, "logger" | "logLevel"> | undefined): unknown {
	try {
		return JSON.parse(data);
	} catch {
		logError(client, "Could not parse message into JSON:");
		logError(client, "From chunk:");
		throw new SyntaxError("Error reading response: malformed server-sent event JSON.");
	}
}

/**
 * The events of a streamed OpenAI SDK response (`create(...).withResponse()` with `stream: true`), read from the response
 * body with decodeSseText() instead of the SDK's Stream. The SDK looks at the body one byte at a time to find line and
 * event ends, decodes every line separately and keeps its state in private fields; this costs a few microseconds per
 * event rather than tens.
 *
 * What comes out, and when, is what iterating `stream` gives (openai/core/streaming, Stream.fromSSEResponse): `[DONE]` ends
 * the events and cancels the body; an `error` event or an event whose data has an `error` throws an APIError; `thread.*`
 * events come as `{ event, data }`; an aborted request ends the events without an error; and if the iteration stops before
 * the end, the request is aborted through the stream's controller. `client` is the client that made the request, whose
 * logger reports data that is not JSON. `stream` itself is iterated when it is not the SDK's Stream (a client whose
 * `create()` returns something else) or the response has no body.
 */
export async function* iterateOpenAIStream<T>(
	stream: AsyncIterable<T>,
	response: Response,
	client?: Pick<OpenAI, "logger" | "logLevel">,
): AsyncGenerator<T> {
	if (!(stream instanceof Stream) || !response.body) {
		yield* stream;
		return;
	}

	const controller = stream.controller;
	let done = false;
	let receivedCompletionSentinel = false;
	const messages = iterateOpenAISseMessages(response.body, controller.signal);
	const closeMessages = messages.return.bind(messages);
	messages.return = (value) => {
		// Abort before the body's cancellation, which could wait on the network.
		if (!receivedCompletionSentinel) controller.abort();
		return closeMessages(value);
	};
	try {
		for await (const sse of messages) {
			if (sse.data === "[DONE]") {
				receivedCompletionSentinel = true;
				break;
			}
			const data = parseEventData(sse.data, client) as { error?: unknown } | null;
			if (sse.event === null || !sse.event.startsWith("thread.")) {
				if (sse.event === "error") {
					throw new APIError(undefined, (data?.error ?? data) as object, undefined, response.headers);
				}
				if (data?.error) {
					throw new APIError(undefined, data.error as object, undefined, response.headers);
				}
				yield data as T;
			} else {
				yield { event: sse.event, data } as T;
			}
		}
		done = true;
	} catch (error) {
		if (
			receivedCompletionSentinel ||
			(!(error instanceof APIError) && isAbortError(error)) ||
			(controller.signal.aborted && error === controller.signal.reason)
		) {
			return;
		}
		throw error;
	} finally {
		if (!done) controller.abort();
	}
}
