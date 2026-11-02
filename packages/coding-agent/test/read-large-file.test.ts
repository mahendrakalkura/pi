import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

/** Deterministic pseudo-random numbers, so a failing case can be found again. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

/** Text of `bytes` bytes or more with lines of varied length and content (ASCII, multi-byte, invalid UTF-8, "\r"). */
function makeFile(seed: number, bytes: number, options: { longLines?: boolean; invalid?: boolean } = {}): Buffer {
	const next = random(seed);
	const parts: Buffer[] = [];
	let length = 0;
	let line = 0;
	while (length < bytes) {
		const kind = next();
		let text: Buffer;
		if (options.longLines && kind < 0.02) text = Buffer.from("L".repeat(20_000 + Math.floor(next() * 80_000)));
		else if (kind < 0.1) text = Buffer.alloc(0);
		else if (kind < 0.3) text = Buffer.from(`café \u{1f600} 中文 line ${line}`.repeat(1 + Math.floor(next() * 4)));
		else if (options.invalid && kind < 0.4)
			text = Buffer.from([0x61, 0xe2, 0x82, 0xff, 0xc3, 0x80, 0x80, 0xf0, 0x9f]);
		else if (kind < 0.45) text = Buffer.from(`crlf ${line}\r`);
		else text = Buffer.from(`line ${line} ${"x".repeat(Math.floor(next() * 120))}`);
		parts.push(text, Buffer.from("\n"));
		length += text.length + 1;
		line++;
	}
	return Buffer.concat(parts);
}

describe("read tool on files read in chunks", () => {
	let dir: string;
	// The default tool reads files of 1 MiB or more in chunks; one with its own readFile reads them whole, as before.
	const chunked = () => createReadToolDefinition(dir);
	const whole = () =>
		createReadToolDefinition(dir, {
			operations: {
				readFile: (path) => readFile(path),
				access: async () => {},
				detectImageMimeType: async () => null,
			},
		});

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-read-large-"));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function expectSame(file: string, args: { offset?: number; limit?: number }): Promise<void> {
		const run = async (tool: ReturnType<typeof createReadToolDefinition>) => {
			try {
				const result = await tool.execute("id", { path: file, ...args }, undefined, undefined, undefined as never);
				return { content: result.content, details: result.details };
			} catch (error) {
				return { error: (error as Error).message };
			}
		};
		const expected = await run(whole());
		const actual = await run(chunked());
		expect(actual, `${file} ${JSON.stringify(args)}`).toStrictEqual(expected);
	}

	const offsets = (lines: number, next: () => number) => [
		{},
		{ offset: 1 },
		{ limit: 10 },
		{ limit: 0 },
		{ offset: 2, limit: 1 },
		{ offset: Math.floor(lines / 2), limit: 50 },
		{ offset: Math.floor(lines * next()) + 1 },
		{ offset: Math.floor(lines * next()) + 1, limit: Math.floor(next() * 3000) },
		{ offset: lines - 1 },
		{ offset: lines },
		{ offset: lines + 1 },
		{ offset: lines + 5, limit: 3 },
		{ offset: 2.7, limit: 4.2 },
	];

	it("gives the output of reading the whole file", async () => {
		const cases: { name: string; content: Buffer }[] = [
			{ name: "ascii.log", content: makeFile(1, 3 * 1024 * 1024) },
			{ name: "mixed.txt", content: makeFile(2, 1024 * 1024 + 17, { invalid: true }) },
			{ name: "long-lines.txt", content: makeFile(3, 2 * 1024 * 1024, { longLines: true, invalid: true }) },
			{ name: "no-trailing-newline.txt", content: makeFile(4, 1024 * 1024).subarray(0, -1) },
			{ name: "one-line.txt", content: Buffer.from("y".repeat(1024 * 1024 + 3)) },
			{
				name: "first-line-long.txt",
				content: Buffer.concat([Buffer.from("é".repeat(60_000)), Buffer.from("\n"), makeFile(5, 1024 * 1024)]),
			},
			{
				name: "bom-invalid-at-chunk-ends.txt",
				content: Buffer.concat([
					Buffer.from([0xef, 0xbb, 0xbf]),
					Buffer.from("a".repeat(1024 * 1024 - 4)),
					Buffer.from([0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0xc3, 0x0a, 0x80, 0x80, 0x80, 0x80]),
					Buffer.from("\n".repeat(2500)),
					Buffer.from("é".repeat(30_000)),
				]),
			},
			{ name: "newlines.txt", content: Buffer.from("\n".repeat(1024 * 1024 + 1)) },
			{
				// A first line whose size shows as 60.1KB decoded (61,492 bytes) and 60.0KB as raw bytes (61,490).
				name: "first-line-invalid.txt",
				content: Buffer.concat([
					Buffer.from("a".repeat(61_489)),
					Buffer.from([0xff, 0x0a]),
					makeFile(7, 1024 * 1024),
				]),
			},
			{
				// 61,491 bytes decoded shows as 60.0KB, one more as 60.1KB.
				name: "first-line-boundary.txt",
				content: Buffer.concat([
					Buffer.from("a".repeat(61_488)),
					Buffer.from([0xff, 0x0a]),
					makeFile(8, 1024 * 1024),
				]),
			},
		];
		const next = random(42);
		for (const { name, content } of cases) {
			writeFileSync(join(dir, name), content);
			let lines = 1;
			for (const byte of content) if (byte === 0x0a) lines++;
			for (const args of offsets(lines, next)) await expectSame(name, args);
		}
	});

	it("keeps files under 1 MiB on the whole-file path", async () => {
		writeFileSync(join(dir, "small.txt"), makeFile(6, 200_000, { invalid: true }));
		await expectSame("small.txt", { offset: 3, limit: 7 });
	});
});
