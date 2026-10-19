import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ImageProcessModule from "../../src/utils/image-process.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const processImageCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/utils/image-process.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof ImageProcessModule>();
	return {
		...actual,
		processImage: (...args: Parameters<typeof actual.processImage>) => {
			processImageCalls.count++;
			return actual.processImage(...args);
		},
	};
});

function pngChunk(type: string, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(body.length, 0);
	header.write(type, 4, "ascii");
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0);
	return Buffer.concat([header, body, checksum]);
}

/** An 8-bit grayscale PNG with horizontal stripes (small enough to stay PNG after resizing). */
function createPng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	const raw = Buffer.alloc((width + 1) * height);
	for (let row = 0; row < height; row++) {
		raw.fill(row % 256, row * (width + 1) + 1, (row + 1) * (width + 1));
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

describe("AgentSession read of images", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		processImageCalls.count = 0;
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function readImage(name: string, data: Buffer): Promise<(TextContent | ImageContent)[]> {
		const harness = await createHarness();
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, name), data);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: name })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("look at the image");
		return getToolResult(harness, "read").content;
	}

	it("sends an image within the limits byte for byte, processed once", async () => {
		const png = createPng(1800, 1100);

		const content = await readImage("small.png", png);

		expect(content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
		]);
		// The read tool processes it; tool-result normalization recognizes the result and skips it.
		expect(processImageCalls.count).toBe(1);
	});

	it("resizes an image over the limits once, with the dimension note", async () => {
		const png = createPng(2442, 1438);

		const content = await readImage("shot.png", png);

		expect(content).toHaveLength(2);
		const [note, image] = content;
		expect(note).toEqual({
			type: "text",
			text: "Read image file [image/png]\n[Image: original 2442x1438, displayed at 2000x1178. Multiply coordinates by 1.22 to map to original image.]",
		});
		if (image.type !== "image") throw new Error("Expected an image");
		expect(image.mimeType).toBe("image/png");
		const resized = Buffer.from(image.data, "base64");
		expect([resized.readUInt32BE(16), resized.readUInt32BE(20)]).toEqual([2000, 1178]);
		expect(processImageCalls.count).toBe(1);
	});
});
