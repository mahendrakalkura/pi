/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
export function stripBom(content: string): string {
	return splitBom(content).text;
}

/**
 * A copy of `text` that shares no memory with the string it was cut from. Substrings (`slice`, `split`, regex
 * matches) of a long string reference that string in JavaScriptCore and V8, so keeping a short piece of a large file
 * or output keeps all of it alive. For well-formed text (it goes through UTF-8, which keeps ASCII text at one byte per
 * character where UTF-16 would take two; a lone surrogate would become U+FFFD).
 */
export function detachString(text: string): string {
	return Buffer.from(text, "utf-8").toString("utf-8");
}

/** Below this many characters an output is not worth looking up. */
const SHARED_MIN_CHARS = 4096;
/** How many characters of outputs `detachSharedString` keeps for later equal ones (oldest dropped first). */
const SHARED_MAX_CHARS = 2 * 1024 * 1024;
const sharedStrings = new Map<string, string>();
let sharedChars = 0;

/**
 * `detachString(text)`, or the copy it returned before for the same content: a file read again unchanged then costs
 * the session no second copy. The latest copies are kept, up to 2M characters.
 */
export function detachSharedString(text: string): string {
	if (text.length < SHARED_MIN_CHARS) return detachString(text);
	const held = sharedStrings.get(text);
	if (held !== undefined) {
		// (Most recently used last.)
		sharedStrings.delete(held);
		sharedStrings.set(held, held);
		return held;
	}
	const copy = detachString(text);
	sharedStrings.set(copy, copy);
	sharedChars += copy.length;
	for (const oldest of sharedStrings.keys()) {
		if (sharedChars <= SHARED_MAX_CHARS || oldest === copy) break;
		sharedStrings.delete(oldest);
		sharedChars -= oldest.length;
	}
	return copy;
}

/** How many characters `detachSharedString` holds (for tests). */
export function sharedStringChars(): number {
	return sharedChars;
}
