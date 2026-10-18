/**
 * Serializing a conversation for a request reuses the JSON of the long strings serialized for the requests before it.
 *
 * Every request resends the whole conversation, and JSON.stringify escapes every string in it again: in a long
 * session that grows to the largest share of the CPU a turn takes. The strings themselves do not change: a tool
 * result or an answer is serialized again for every request after the one it first appears in.
 *
 * cacheJsonSerialization(messages) gives the messages array a toJSON that returns a copy of it with each long string
 * replaced by a JSON.rawJSON() value holding the string's serialized form, kept from the previous request.
 * JSON.stringify copies those as they are. The output is byte-identical to JSON.stringify of the original array.
 * Without JSON.rawJSON (older engines) nothing changes.
 *
 * The array, not the request body, carries the toJSON: SDKs copy the body (`{ ...params }`, `const { betas, ...body } =
 * params`) before they serialize it, and those copies keep the array but not a property that is not enumerable.
 *
 * Strings are cached by value. Serializations in the same task (one request body, read synchronously) make one
 * generation; a string that the latest generation did not use is kept for one more, then dropped. So the cache holds
 * about one request's long strings, and two conversations that take turns still reuse theirs.
 */

const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

/** Shorter strings are cheap to escape again; caching them would cost more in entries than it saves. */
const MIN_CACHED_LENGTH = 1024;

let current = new Map<string, unknown>();
let previous = new Map<string, unknown>();
let generationOpen = false;

function startGeneration(): void {
	if (generationOpen) return;
	generationOpen = true;
	previous = current;
	current = new Map();
	queueMicrotask(() => {
		generationOpen = false;
	});
}

function cachedString(value: string, toRaw: (text: string) => unknown): unknown {
	let raw = current.get(value);
	if (raw === undefined) {
		raw = previous.get(value) ?? toRaw(JSON.stringify(value));
		current.set(value, raw);
	}
	return raw;
}

/**
 * A copy of `value` for JSON.stringify, with long strings replaced by their cached raw JSON. Only arrays and plain
 * objects are copied; anything JSON.stringify treats specially (toJSON, boxed primitives, class instances) is left as
 * it is, as is a cycle (JSON.stringify then throws for it as before).
 */
function substitute(value: unknown, toRaw: (text: string) => unknown, ancestors: Set<object>): unknown {
	if (typeof value === "string") {
		return value.length >= MIN_CACHED_LENGTH ? cachedString(value, toRaw) : value;
	}
	if (value === null || typeof value !== "object" || ancestors.has(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		return typeof (value as { toJSON?: unknown }).toJSON === "function"
			? value
			: substituteItems(value, toRaw, ancestors);
	}
	const proto = Object.getPrototypeOf(value);
	if ((proto !== Object.prototype && proto !== null) || typeof (value as { toJSON?: unknown }).toJSON === "function") {
		return value;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	// Assigning "__proto__" would set the copy's prototype instead of a property.
	if (keys.includes("__proto__")) return value;
	ancestors.add(value);
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		out[key] = substitute(record[key], toRaw, ancestors);
	}
	ancestors.delete(value);
	return out;
}

function substituteItems(
	items: readonly unknown[],
	toRaw: (text: string) => unknown,
	ancestors: Set<object>,
): unknown[] {
	ancestors.add(items);
	const out = new Array<unknown>(items.length);
	for (let i = 0; i < items.length; i++) {
		out[i] = substitute(items[i], toRaw, ancestors);
	}
	ancestors.delete(items);
	return out;
}

/**
 * Makes JSON.stringify of `items` (a request's messages) reuse the serialized form of long strings serialized before,
 * by defining a non-enumerable toJSON on the array. Does nothing to anything but a plain array without a toJSON.
 */
export function cacheJsonSerialization(items: unknown): void {
	const toRaw = rawJSON;
	if (
		!toRaw ||
		!Array.isArray(items) ||
		Object.getPrototypeOf(items) !== Array.prototype ||
		Object.hasOwn(items, "toJSON")
	) {
		return;
	}
	Object.defineProperty(items, "toJSON", {
		value(this: unknown[]): unknown {
			startGeneration();
			return substituteItems(this, toRaw, new Set());
		},
		configurable: true,
		writable: true,
		enumerable: false,
	});
}
