import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { detachSharedString, sharedStringChars } from "../src/utils/text.ts";

/** A string of `length` characters made at run time. */
function made(seed: string, length: number): string {
	return Array.from({ length: Math.ceil(length / seed.length) }, () => seed)
		.join("")
		.slice(0, length);
}

describe("detachSharedString", () => {
	test("holds equal long content once", () => {
		const before = sharedStringChars();
		expect(detachSharedString(made("abc\n", 8192))).toBe(made("abc\n", 8192));
		expect(sharedStringChars()).toBe(before + 8192);
		expect(detachSharedString(made("abc\n", 8192))).toBe(made("abc\n", 8192));
		expect(sharedStringChars()).toBe(before + 8192);
		expect(detachSharedString(`${made("abc\n", 8191)}x`)).toBe(`${made("abc\n", 8191)}x`);
		expect(sharedStringChars()).toBe(before + 2 * 8192);
	});

	test("returns the text unchanged: short, non-ASCII, and a slice of a longer string", () => {
		const before = sharedStringChars();
		expect(detachSharedString("short")).toBe("short");
		expect(sharedStringChars()).toBe(before);
		const text = made("héllo wörld ✓ 𝄞\n", 10_000);
		expect(detachSharedString(text)).toBe(text);
		const long = made("0123456789", 100_000);
		expect(detachSharedString(long.slice(5, 50_005))).toBe(long.slice(5, 50_005));
	});

	test("holds at most 2M characters, dropping the oldest", () => {
		for (let i = 0; i < 6; i++) detachSharedString(made(`filler ${i}\n`, 600_000));
		expect(sharedStringChars()).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(sharedStringChars()).toBeGreaterThanOrEqual(3 * 600_000);
	});
});

describe("read tool", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-read-shared-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("a file read again gives its current content, held once while unchanged", async () => {
		const path = join(dir, "big.txt");
		writeFileSync(path, made("line of the file\n", 20_000));
		const read = createReadTool(dir);
		const text = async () => {
			const result = await read.execute("call", { path }, undefined, undefined);
			const block = result.content[0];
			if (block.type !== "text") throw new Error("expected text");
			return block.text;
		};
		const first = await text();
		const held = sharedStringChars();
		expect(await text()).toBe(first);
		expect(sharedStringChars()).toBe(held);
		writeFileSync(path, made("another line\n", 20_000));
		const changed = await text();
		expect(changed.startsWith("another line\n")).toBe(true);
		expect(changed).not.toBe(first);
	});
});
