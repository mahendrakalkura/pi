import { parse as partialParse } from "partial-json";
import type { ToolCall } from "../types.ts";

const HEX_DIGITS = /^[0-9a-fA-F]{4}$/;
const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 *
 * Returns `json` itself when nothing needs repair. Unchanged runs are copied with slice() rather than one character at a
 * time: streamed tool-call arguments, often a whole file, come through here each time they are parsed.
 */
export function repairJson(json: string): string {
	let repaired = "";
	// Start of the run of characters that has not been copied to `repaired` yet.
	let runStart = 0;
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const code = json.charCodeAt(index);

		if (!inString) {
			if (code === 0x22) {
				inString = true;
			}
			continue;
		}

		if (code === 0x22) {
			inString = false;
			continue;
		}

		if (code === 0x5c) {
			const nextChar = json[index + 1];
			// "\u" stays as it is only with four hex digits after it; otherwise its backslash is doubled.
			if (nextChar === "u" && HEX_DIGITS.test(json.slice(index + 2, index + 6))) {
				index += 5;
				continue;
			}
			if (nextChar !== undefined && VALID_JSON_ESCAPES.has(nextChar)) {
				index += 1;
				continue;
			}
			repaired += `${json.slice(runStart, index)}\\\\`;
			runStart = index + 1;
			continue;
		}

		if (code <= 0x1f) {
			repaired += json.slice(runStart, index) + escapeControlCharacter(json[index]);
			runStart = index + 1;
		}
	}

	return runStart === 0 ? json : repaired + json.slice(runStart);
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Parses the model's complete arguments text of a finished tool call.
 *
 * Unlike {@link parseStreamingJson}, this never keeps a partially parsed prefix: once the call is
 * finished, text that is not a valid JSON object means the model sent malformed arguments. In that
 * case `arguments` is `{}` and `argumentsError` describes the problem, including the text the
 * model sent, so tool validation can report it back to the model.
 */
export function parseToolCallArguments(json: string | undefined): Pick<ToolCall, "arguments" | "argumentsError"> {
	if (!json?.trim()) return { arguments: {} };
	try {
		const parsed = parseJsonWithRepair<ToolCall["arguments"] | null>(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Tool arguments must be a JSON object");
		}
		return { arguments: parsed };
	} catch (error) {
		return {
			arguments: {},
			argumentsError: `${error instanceof Error ? error.message : String(error)}\n\nReceived arguments:\n${json}`,
		};
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
