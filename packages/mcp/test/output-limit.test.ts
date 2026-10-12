import { describe, expect, it } from "vitest";
import { type LlmContent, limitMcpContent, MCP_OUTPUT_MAX_BYTES } from "../src/index.ts";

const image: LlmContent = { type: "image", data: "AAAA", mimeType: "image/png" };

function textOf(content: LlmContent[]): string {
	const [first] = content;
	if (first?.type !== "text") throw new Error("expected a text block first");
	return first.text;
}

describe("limitMcpContent", () => {
	it("returns content within the limit as it is, without saving", async () => {
		const content: LlmContent[] = [{ type: "text", text: "x".repeat(MCP_OUTPUT_MAX_BYTES) }, image];
		let saves = 0;
		const limited = await limitMcpContent(content, async () => {
			saves++;
			return "/tmp/full.txt";
		});
		expect(limited).toEqual({ content });
		expect(limited.content).toBe(content);
		expect(saves).toBe(0);
	});

	it("cuts the middle of longer text, saves the full text and keeps images", async () => {
		const full = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n");
		const saved: [string | Uint8Array, string][] = [];
		const split = full.indexOf("\n", 100);
		const limited = await limitMcpContent(
			[{ type: "text", text: full.slice(0, split) }, image, { type: "text", text: full.slice(split + 1) }],
			async (data, extension) => {
				saved.push([data, extension]);
				return "/tmp/full.txt";
			},
		);
		// Text blocks are joined with newlines before the limit applies.
		expect(saved).toEqual([[full, ".txt"]]);
		expect(limited.fullOutputPath).toBe("/tmp/full.txt");
		expect(limited.content).toHaveLength(2);
		expect(limited.content[1]).toEqual(image);
		const text = textOf(limited.content);
		expect(text).toMatch(
			new RegExp(
				`^Warning: truncated output \\(original token count: ${Math.ceil(full.length / 4)}\\)\nTotal output lines: 3000\n\nline 1\nline 2\n`,
			),
		);
		expect(text).toMatch(/…\d+ chars truncated…/);
		expect(text.endsWith("line 3000\n\n[Full output: /tmp/full.txt (read it with offset/limit)]")).toBe(true);
		expect(Buffer.byteLength(text)).toBeLessThan(MCP_OUTPUT_MAX_BYTES + 1024);
	});

	it("reports a failed save, and names no file without a saver", async () => {
		const content: LlmContent[] = [{ type: "text", text: "y".repeat(MCP_OUTPUT_MAX_BYTES + 1) }];
		const failed = await limitMcpContent(content, async () => {
			throw new Error("disk full");
		});
		expect(failed.fullOutputPath).toBeUndefined();
		expect(textOf(failed.content).endsWith("\n\n[Could not save the full output: disk full]")).toBe(true);

		const unsaved = await limitMcpContent(content);
		expect(unsaved.fullOutputPath).toBeUndefined();
		expect(textOf(unsaved.content)).toMatch(/^Warning: truncated output .*…\d+ chars truncated…y+$/s);
	});

	it("cuts multi-byte text only at character boundaries", async () => {
		// After the one-byte prefix, characters start at odd bytes, and both cuts (byte 10240 and byte
		// 40004 - 10240) are even: each lands inside a two-byte character.
		const text = `a${"é".repeat(20_000)}end`;
		const limited = textOf((await limitMcpContent([{ type: "text", text }])).content);
		expect(limited).not.toContain("\uFFFD");
		expect(limited.endsWith("end")).toBe(true);
		const marker = /…(\d+) chars truncated…/.exec(limited);
		if (!marker) throw new Error("expected the truncation marker");
		const [head, tail] = limited.slice(limited.indexOf("\n\n") + 2).split(marker[0]);
		expect(Buffer.byteLength(head)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_BYTES / 2);
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_BYTES / 2);
		expect(Array.from(head).length + Array.from(tail).length + Number(marker[1])).toBe(Array.from(text).length);
	});

	it("counts removed characters and lines as splitting the text would", async () => {
		// Surrogate pairs, lone surrogates (U+FFFD in UTF-8), multi-byte characters, CR/LF variants and a final newline.
		const pieces = ["a", "xyz", "\n", "\n\n", "\r\n", "\r", "é", "€", "😀", "\ud800", "\udc00", "中文"];
		let state = 0x5eed;
		const random = () => {
			state = (state * 1103515245 + 12345) >>> 0;
			return state / 4294967296;
		};
		for (let i = 0; i < 200; i++) {
			const parts: string[] = [];
			// Twice the limit: adjacent lone surrogates join into a pair of fewer bytes than the two counted apart.
			for (let bytes = 0; bytes <= 2 * MCP_OUTPUT_MAX_BYTES; ) {
				const piece = pieces[Math.floor(random() * pieces.length)];
				parts.push(piece);
				bytes += Buffer.byteLength(piece);
			}
			let text = parts.join("");
			if (random() < 0.5) text += "\n";
			const limited = textOf((await limitMcpContent([{ type: "text", text }])).content);
			const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
			expect(limited).toContain(`\nTotal output lines: ${lines}\n`);
			const marker = /…(\d+) chars truncated…/.exec(limited);
			if (!marker) throw new Error("expected the truncation marker");
			const [head, tail] = limited.slice(limited.indexOf("\n\n") + 2).split(marker[0]);
			const removed = Buffer.from(text, "utf-8").subarray(
				Buffer.byteLength(head),
				Buffer.byteLength(text) - Buffer.byteLength(tail),
			);
			expect(Number(marker[1])).toBe(Array.from(removed.toString("utf-8")).length);
		}
	});
});
