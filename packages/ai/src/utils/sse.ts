/** One server-sent event: its `event:` field, its `data:` lines joined with "\n", and the lines it was made of. */
export interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

/** What a server-sent event decoder keeps between reads. */
export interface SseDecoder {
	event: string | null;
	data: string[];
	raw: string[];
	/** Remove a byte order mark from the start of every line, as decoding each line on its own does (the OpenAI SDK). */
	stripLineBom: boolean;
	/** The text after the last complete line. */
	rest: string;
	/** The last read ended with "\r": a "\n" at the start of the next one belongs to it. */
	skipLeadingNewline: boolean;
}

export function createSseDecoder(options: { stripLineBom?: boolean } = {}): SseDecoder {
	return {
		event: null,
		data: [],
		raw: [],
		stripLineBom: options.stripLineBom ?? false,
		rest: "",
		skipLeadingNewline: false,
	};
}

function flushSseEvent(state: SseDecoder): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		// Handed over rather than copied: the state gets a new array below.
		raw: state.raw,
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoder): ServerSentEvent | null {
	if (state.stripLineBom && line.charCodeAt(0) === 0xfeff) {
		line = line.slice(1);
	}
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

/**
 * Decodes the next piece of text of a stream: yields the events that the complete lines in it finish and keeps the rest
 * for the next call. Lines end at "\r\n", "\r" or "\n"; a "\r" at the end ends its line at once, and a "\n" that starts
 * the next piece is then skipped. The next "\r" and "\n" are each searched for once per occurrence: searching the rest
 * of the buffer for both after every line, and slicing that rest off, made decoding a read quadratic in the number of
 * events it carried.
 *
 * With `final` (the end of the stream), the text after the last line end is decoded as a line, and an event that the
 * stream ends without a blank line after is yielded too.
 */
export function* decodeSseText(state: SseDecoder, text: string, final: boolean): Generator<ServerSentEvent> {
	let lineStart = 0;
	if (state.skipLeadingNewline && text.length > 0) {
		state.skipLeadingNewline = false;
		if (text.charCodeAt(0) === 0x0a) lineStart = 1;
	}
	let buffer = text;
	if (state.rest.length > 0) {
		buffer = state.rest + text.slice(lineStart);
		lineStart = 0;
		state.rest = "";
	}

	let carriageReturn = buffer.indexOf("\r", lineStart);
	let newline = buffer.indexOf("\n", lineStart);
	while (carriageReturn !== -1 || newline !== -1) {
		const lineEnd =
			carriageReturn === -1 ? newline : newline === -1 ? carriageReturn : Math.min(carriageReturn, newline);
		let next = lineEnd + 1;
		if (lineEnd === carriageReturn) {
			if (newline === next) next += 1;
			else if (next === buffer.length) state.skipLeadingNewline = !final;
		}
		const event = decodeSseLine(buffer.slice(lineStart, lineEnd), state);
		if (event) {
			yield event;
		}
		lineStart = next;
		if (carriageReturn !== -1 && carriageReturn < next) carriageReturn = buffer.indexOf("\r", next);
		if (newline !== -1 && newline < next) newline = buffer.indexOf("\n", next);
	}

	if (final) {
		if (lineStart < buffer.length) {
			const event = decodeSseLine(buffer.slice(lineStart), state);
			if (event) {
				yield event;
			}
		}
		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} else if (lineStart < buffer.length) {
		state.rest = lineStart === 0 ? buffer : buffer.slice(lineStart);
	}
}

/**
 * The server-sent events of a response body. The bytes are decoded as UTF-8 as they arrive and split into lines with
 * indexOf(), rather than searched for line ends one byte at a time. Once `signal` is aborted, the next read throws
 * "Request was aborted".
 */
export async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	options: { signal?: AbortSignal } = {},
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state = createSseDecoder();

	try {
		while (true) {
			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			yield* decodeSseText(state, decoder.decode(value, { stream: true }), false);
		}

		yield* decodeSseText(state, decoder.decode(), true);
	} finally {
		reader.releaseLock();
	}
}
