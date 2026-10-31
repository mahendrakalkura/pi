import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PhotonModule from "../src/utils/photon.ts";

const photonLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/utils/photon.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof PhotonModule>();
	return {
		...actual,
		loadPhoton: () => {
			photonLoads.count++;
			return actual.loadPhoton();
		},
	};
});

import {
	readGifHeader,
	readImageHeader,
	readJpegHeader,
	readPngHeader,
	readWebpHeader,
} from "../src/utils/image-header.ts";
import { keepValidImageWithinLimits, resizeImage } from "../src/utils/image-resize.ts";
import {
	readDisplayedImageSize,
	resizeImageInProcess,
	resolveImageResizeOptions,
} from "../src/utils/image-resize-core.ts";
import type { NativeImageConstructor } from "../src/utils/image-resize-native.ts";
import { loadPhoton } from "../src/utils/photon.ts";

// Small 2x2 blue JPEG image (baseline) - generated with ImageMagick
const JPEG_2X2 =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

const JPEG_PROGRESSIVE_5X3 =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAADAAUDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABsHUX/8QAFhABAQEAAAAAAAAAAAAAAAAAAgER/9oACAEBAAEFAk7n/8QAGhEAAgIDAAAAAAAAAAAAAAAAAQMABBMikf/aAAgBAwEBPwFFVGMaDk//xAAYEQEAAwEAAAAAAAAAAAAAAAABAANxsf/aAAgBAgEBPwGxRMOT/8QAFhAAAwAAAAAAAAAAAAAAAAAAAAEh/9oACAEBAAY/AlT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IRH/2gAMAwEAAgADAAAAEA//xAAWEQADAAAAAAAAAAAAAAAAAAAAwdH/2gAIAQMBAT8QWdD/xAAWEQEBAQAAAAAAAAAAAAAAAAABAPH/2gAIAQIBAT8QABwX/8QAGBABAQADAAAAAAAAAAAAAAAAAREAQWH/2gAIAQEAAT8QK9Vujmf/2Q==";

const WEBP_LOSSY_5X3 =
	"UklGRmwAAABXRUJQVlA4IGAAAADwAQCdASoFAAMAAUAmJbACdLoAArl9WmgA/fzw9op6bHEwjhOVx/wF//v//yHC9hWy7jAdxkLZm35O/zZfR5/8m3wfmv+c4Nh/5N//UMf+w/6cWv9zf/10HG9vn+MAAAA=";

const WEBP_LOSSLESS_5X3 = "UklGRjoAAABXRUJQVlA4TC0AAAAvBIAAAHcgFkz8eQfQmcJETNP8Z7SBgkaSmu+FrgVPaMETWhAW0f9YW87N9wcA";

// VP8X canvas with an ALPH chunk and a VP8 bitstream.
const WEBP_ALPHA_5X3 =
	"UklGRpQAAABXRUJQVlA4WAoAAAAQAAAABAAAAgAAQUxQSA0AAAABD/DA/4iIMAER/Y8AAFZQOCBgAAAA8AEAnQEqBQADAAFAJiWwAnS6AAK5fVpoAP388PaKemxxMI4Tlcf318/v/97ZLZm3/CpcMWRAgV+Tv82X0ef/Jt8H5r/nODYf+Tf/1DH/sP+nFr/c3/9h10Fke/mQAAAA";

function bytes(base64: string): Buffer {
	return Buffer.from(base64, "base64");
}

function pngChunk(type: string, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(body.length, 0);
	header.write(type, 4, "ascii");
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0);
	return Buffer.concat([header, body, checksum]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width: number, height: number, bitDepth = 8, colorType = 0): Buffer {
	const body = Buffer.alloc(13);
	body.writeUInt32BE(width, 0);
	body.writeUInt32BE(height, 4);
	body[8] = bitDepth;
	body[9] = colorType;
	return pngChunk("IHDR", body);
}

/** An 8-bit grayscale PNG. */
function createPng(width: number, height: number): Buffer {
	const raw = Buffer.alloc((width + 1) * height);
	for (let row = 0; row < height; row++) {
		raw.fill((row * 7) % 256, row * (width + 1) + 1, (row + 1) * (width + 1));
	}
	return Buffer.concat([
		PNG_SIGNATURE,
		ihdr(width, height),
		pngChunk("tEXt", Buffer.from("Comment\0test")),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * LZW image data for `pixels` pixels of colour 0: minimum code size 2, so codes are 3 bits wide
 * (clear = 4, end = 5). A clear code after every two pixels keeps the code width at 3 bits.
 */
function gifImageData(pixels: number): Buffer {
	const codes: number[] = [];
	for (let i = 0; i < pixels; i++) {
		if (i % 2 === 0) codes.push(4);
		codes.push(0);
	}
	codes.push(5);
	const packed: number[] = [];
	let bits = 0;
	let bitCount = 0;
	for (const code of codes) {
		bits |= code << bitCount;
		bitCount += 3;
		while (bitCount >= 8) {
			packed.push(bits & 0xff);
			bits >>= 8;
			bitCount -= 8;
		}
	}
	if (bitCount > 0) packed.push(bits & 0xff);
	const blocks: number[] = [0x02];
	for (let i = 0; i < packed.length; i += 255) {
		const block = packed.slice(i, i + 255);
		blocks.push(block.length, ...block);
	}
	blocks.push(0);
	return Buffer.from(blocks);
}

/** A GIF with a 2-colour global table and the given frames ([left, top, width, height]). */
function createGif(width: number, height: number, frames: [number, number, number, number][]): Buffer {
	const parts: Buffer[] = [Buffer.from("GIF89a", "ascii")];
	const screen = Buffer.alloc(7);
	screen.writeUInt16LE(width, 0);
	screen.writeUInt16LE(height, 2);
	screen[4] = 0x80; // global colour table, 2 entries
	parts.push(screen, Buffer.from([0, 0, 0, 255, 255, 255]));
	// Graphic control extension.
	parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]));
	for (const [left, top, frameWidth, frameHeight] of frames) {
		const descriptor = Buffer.alloc(10);
		descriptor[0] = 0x2c;
		descriptor.writeUInt16LE(left, 1);
		descriptor.writeUInt16LE(top, 3);
		descriptor.writeUInt16LE(frameWidth, 5);
		descriptor.writeUInt16LE(frameHeight, 7);
		parts.push(descriptor, gifImageData(frameWidth * frameHeight));
	}
	parts.push(Buffer.from([0x3b]));
	return Buffer.concat(parts);
}

function riff(chunks: Buffer[]): Buffer {
	const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks]);
	const header = Buffer.alloc(8);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

function webpChunk(type: string, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.write(type, 0, "ascii");
	header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function vp8x(width: number, height: number, flags = 0): Buffer {
	const body = Buffer.alloc(10);
	body[0] = flags;
	body.writeUIntLE(width - 1, 4, 3);
	body.writeUIntLE(height - 1, 7, 3);
	return webpChunk("VP8X", body);
}

/** The chunks of a simple WebP file (everything after "RIFF" size "WEBP"). */
function webpChunks(base64: string): Buffer {
	return bytes(base64).subarray(12);
}

function app1Exif(orientation: number): Buffer {
	const tiff = Buffer.from("49492a00080000000100120103000100000000000000000000000000", "hex");
	tiff.writeUInt16LE(orientation, 18);
	const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
	const segment = Buffer.alloc(payload.length + 4);
	segment[0] = 0xff;
	segment[1] = 0xe1;
	segment.writeUInt16BE(payload.length + 2, 2);
	payload.copy(segment, 4);
	return segment;
}

/** Replace the JPEG segment with `marker` by `replace(segment)`. */
function editJpegSegment(jpeg: Buffer, marker: number, replace: (segment: Buffer) => Buffer): Buffer {
	let offset = 2;
	while (offset < jpeg.length) {
		const length = jpeg.readUInt16BE(offset + 2);
		if (jpeg[offset + 1] === marker) {
			const segment = jpeg.subarray(offset, offset + 2 + length);
			return Buffer.concat([
				jpeg.subarray(0, offset),
				replace(Buffer.from(segment)),
				jpeg.subarray(offset + 2 + length),
			]);
		}
		offset += 2 + length;
	}
	throw new Error(`no marker ${marker.toString(16)}`);
}

describe("image header parsers", () => {
	const valid: [string, string, Buffer, number, number][] = [
		["PNG", "image/png", createPng(37, 21), 37, 21],
		["baseline JPEG", "image/jpeg", bytes(JPEG_2X2), 2, 2],
		["progressive JPEG", "image/jpeg", bytes(JPEG_PROGRESSIVE_5X3), 5, 3],
		["GIF", "image/gif", createGif(6, 4, [[0, 0, 6, 4]]), 6, 4],
		[
			"animated GIF with a partial frame",
			"image/gif",
			createGif(6, 4, [
				[0, 0, 6, 4],
				[1, 1, 2, 2],
			]),
			6,
			4,
		],
		["lossy WebP", "image/webp", bytes(WEBP_LOSSY_5X3), 5, 3],
		["lossless WebP", "image/webp", bytes(WEBP_LOSSLESS_5X3), 5, 3],
		["extended WebP with alpha", "image/webp", bytes(WEBP_ALPHA_5X3), 5, 3],
	];

	it.each(valid)(
		"reads the size of a %s, and photon decodes the same size",
		async (_name, mimeType, data, width, height) => {
			expect(readImageHeader(data, mimeType)).toEqual({ width, height });
			const photon = (await loadPhoton())!;
			const image = photon.PhotonImage.new_from_byteslice(data);
			expect([image.get_width(), image.get_height()]).toEqual([width, height]);
			image.free();
		},
	);

	it("returns undefined for a MIME type it does not parse", () => {
		expect(readImageHeader(createPng(2, 2), "image/bmp")).toBeUndefined();
		expect(readImageHeader(createPng(2, 2), "image/jpeg")).toBeUndefined();
	});

	describe("rejects malformed PNG files", () => {
		const png = createPng(4, 3);
		const cases: [string, Buffer][] = [
			["an empty file", Buffer.alloc(0)],
			["a truncated file", png.subarray(0, png.length - 5)],
			["trailing bytes after IEND", Buffer.concat([png, Buffer.from([0])])],
			["a bad signature", Buffer.concat([Buffer.from([0x88]), png.subarray(1)])],
			[
				"a bad chunk CRC",
				(() => {
					const copy = Buffer.from(png);
					copy[copy.length - 13] ^= 0xff; // last byte of the IDAT CRC
					return copy;
				})(),
			],
			[
				"a flipped pixel-data byte",
				(() => {
					const copy = Buffer.from(png);
					copy[png.indexOf("IDAT") + 6] ^= 0x01;
					return copy;
				})(),
			],
			["IHDR not first", Buffer.concat([PNG_SIGNATURE, pngChunk("tEXt", Buffer.from("a\0b")), png.subarray(8)])],
			[
				"no IDAT",
				Buffer.concat([
					PNG_SIGNATURE,
					ihdr(4, 3),
					pngChunk("IEND", Buffer.alloc(0)),
					pngChunk("IEND", Buffer.alloc(0)),
				]),
			],
			["zero width", Buffer.concat([PNG_SIGNATURE, ihdr(0, 3), png.subarray(8 + 25)])],
			["an invalid bit depth", Buffer.concat([PNG_SIGNATURE, ihdr(4, 3, 3, 0), png.subarray(8 + 25)])],
			["a palette image without PLTE", Buffer.concat([PNG_SIGNATURE, ihdr(4, 3, 8, 3), png.subarray(8 + 25)])],
			[
				"a chunk length past the end",
				Buffer.concat([png.subarray(0, 8), Buffer.from([0x7f, 0xff, 0xff, 0xff]), png.subarray(12)]),
			],
		];
		it.each(cases)("%s", (_name, data) => {
			expect(readPngHeader(data)).toBeUndefined();
		});
	});

	describe("rejects malformed or uncommon JPEG files", () => {
		const jpeg = bytes(JPEG_2X2);
		const cases: [string, Buffer][] = [
			["a missing EOI marker", jpeg.subarray(0, jpeg.length - 2)],
			["a truncated file", Buffer.concat([jpeg.subarray(0, 100), Buffer.from([0xff, 0xd9])])],
			["no frame header before the scan", editJpegSegment(jpeg, 0xc0, () => Buffer.alloc(0))],
			[
				"a lossless frame (SOF3)",
				editJpegSegment(jpeg, 0xc0, (s) => Buffer.concat([Buffer.from([0xff, 0xc3]), s.subarray(2)])),
			],
			[
				"an arithmetic-coded frame (SOF9)",
				editJpegSegment(jpeg, 0xc0, (s) => Buffer.concat([Buffer.from([0xff, 0xc9]), s.subarray(2)])),
			],
			[
				"12-bit samples",
				editJpegSegment(jpeg, 0xc0, (s) => {
					s[4] = 12;
					return s;
				}),
			],
			[
				"zero height",
				editJpegSegment(jpeg, 0xc0, (s) => {
					s.writeUInt16BE(0, 5);
					return s;
				}),
			],
			["two frame headers", editJpegSegment(jpeg, 0xc0, (s) => Buffer.concat([s, s]))],
			[
				"a segment length past the end",
				Buffer.concat([jpeg.subarray(0, 4), Buffer.from([0xff, 0xff]), Buffer.from([0xff, 0xd9])]),
			],
			[
				"a restart marker before the scan",
				Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xd0]), jpeg.subarray(2)]),
			],
			["not a JPEG", Buffer.from("not a jpeg at all\xff\xd9", "latin1")],
		];
		it.each(cases)("%s", (_name, data) => {
			expect(readJpegHeader(data)).toBeUndefined();
		});

		it("CMYK (4 components)", () => {
			const cmyk = editJpegSegment(jpeg, 0xc0, (s) => {
				const body = Buffer.alloc(8 + 4 * 3);
				s.copy(body, 0, 2, 9);
				body.writeUInt16BE(body.length, 0);
				body[7] = 4;
				return Buffer.concat([Buffer.from([0xff, 0xc0]), body]);
			});
			expect(readJpegHeader(cmyk)).toBeUndefined();
		});
	});

	describe("rejects malformed GIF files", () => {
		const gif = createGif(6, 4, [[0, 0, 6, 4]]);
		const cases: [string, Buffer][] = [
			["a missing trailer", gif.subarray(0, gif.length - 1)],
			["trailing bytes after the trailer", Buffer.concat([gif, Buffer.from([0])])],
			["no frames", createGif(6, 4, [])],
			["a frame outside the screen", createGif(6, 4, [[4, 0, 6, 4]])],
			["a zero-size screen", createGif(0, 4, [[0, 0, 1, 1]])],
			["an unknown block", Buffer.concat([gif.subarray(0, 19), Buffer.from([0x99]), gif.subarray(19)])],
			["a bad signature", Buffer.concat([Buffer.from("GIF88a", "ascii"), gif.subarray(6)])],
		];
		it.each(cases)("%s", (_name, data) => {
			expect(readGifHeader(data)).toBeUndefined();
		});
	});

	describe("WebP files", () => {
		const lossless = webpChunks(WEBP_LOSSLESS_5X3);

		it("reads an extended still file whose bitstream fills the canvas", () => {
			expect(readWebpHeader(riff([vp8x(5, 3), lossless]))).toEqual({ width: 5, height: 3 });
		});

		const cases: [string, Buffer][] = [
			["a RIFF size that does not match the file", Buffer.concat([bytes(WEBP_LOSSLESS_5X3), Buffer.alloc(2)])],
			["a truncated file", bytes(WEBP_LOSSY_5X3).subarray(0, 40)],
			["an extended canvas larger than its bitstream", riff([vp8x(6, 3), lossless])],
			["an extended file without image data", riff([vp8x(5, 3)])],
			[
				"an animated file",
				riff([vp8x(9, 7, 0x02), webpChunk("ANIM", Buffer.alloc(6)), webpChunk("ANMF", Buffer.alloc(16))]),
			],
			["two bitstreams in a simple file", riff([lossless, lossless])],
			["an unknown first chunk", riff([webpChunk("XXXX", Buffer.alloc(4)), lossless])],
			[
				"a lossless bitstream with a bad signature",
				(() => {
					const copy = Buffer.from(bytes(WEBP_LOSSLESS_5X3));
					copy[20] = 0x2e;
					return copy;
				})(),
			],
			[
				"a lossy bitstream with a bad start code",
				(() => {
					const copy = Buffer.from(bytes(WEBP_LOSSY_5X3));
					copy[23] = 0;
					return copy;
				})(),
			],
		];
		it.each(cases)("rejects %s", (_name, data) => {
			expect(readWebpHeader(data)).toBeUndefined();
		});
	});
});

/** Copy of `data` with byte `offset` set to `value`. */
function withByte(data: Buffer, offset: number, value: number): Buffer {
	const copy = Buffer.from(data);
	copy[offset] = value;
	return copy;
}

// Damaged image data with an intact structure: the header parsers accept these, photon rejects them.
const DAMAGED_JPEG = withByte(bytes(JPEG_PROGRESSIVE_5X3), 555, 0xff);
const DAMAGED_WEBP_LOSSLESS = withByte(bytes(WEBP_LOSSLESS_5X3), 59, 0xff);
const DAMAGED_WEBP_LOSSY = withByte(bytes(WEBP_LOSSY_5X3), 31, 0x55);
/** A GIF whose first LZW code after the clear code (4) is 7, a code not defined yet. */
function damagedGif(): Buffer {
	const gif = createGif(6, 4, [[0, 0, 6, 4]]);
	// Image data starts after the header (13), colour table (6), GCE (8) and descriptor (10): the
	// minimum code size, the sub-block size, then the codes packed 3 bits each, least significant first.
	const codes = 13 + 6 + 8 + 10 + 2;
	gif[codes] = 4 | (7 << 3);
	return gif;
}

/** A PNG whose chunk CRCs are valid but whose compressed pixel data is cut short. */
function damagedPng(): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(30, 0);
	ihdr.writeUInt32BE(20, 4);
	ihdr[8] = 8;
	const raw = deflateSync(Buffer.alloc(31 * 20, 7));
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", raw.subarray(0, 4)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/** A stand-in for Bun.Image whose decode succeeds or fails, recording what it was given. */
function fakeNativeImage(decodes: boolean, log: Uint8Array[]): NativeImageConstructor {
	return class {
		constructor(input: Uint8Array) {
			log.push(input);
		}
		resize() {
			return this;
		}
		rotate() {
			return this;
		}
		flip() {
			return this;
		}
		flop() {
			return this;
		}
		png() {
			return this;
		}
		jpeg() {
			return this;
		}
		async bytes(): Promise<Uint8Array> {
			if (!decodes) throw new Error("ERR_IMAGE_DECODE_FAILED");
			return new Uint8Array(1);
		}
	};
}

describe("images within the limits", () => {
	const opts = resolveImageResizeOptions();

	beforeEach(() => {
		photonLoads.count = 0;
	});
	afterEach(() => {
		photonLoads.count = 0;
	});

	it("are returned as they are when the native decoder decodes them (PNG, WebP)", async () => {
		const log: Uint8Array[] = [];
		const webp = bytes(WEBP_LOSSY_5X3);
		const result = await keepValidImageWithinLimits(webp, "image/webp", 5, 3, opts, fakeNativeImage(true, log));
		expect(result).toEqual({
			data: WEBP_LOSSY_5X3,
			mimeType: "image/webp",
			originalWidth: 5,
			originalHeight: 3,
			width: 5,
			height: 3,
			wasResized: false,
		});
		expect(log).toEqual([webp]);
		const png = createPng(300, 200);
		expect(
			await keepValidImageWithinLimits(png, "image/png", 300, 200, opts, fakeNativeImage(true, [])),
		).toMatchObject({
			data: png.toString("base64"),
		});
		expect(photonLoads.count).toBe(0);
	});

	it("take the photon path when the native decoder fails", async () => {
		expect(
			await keepValidImageWithinLimits(DAMAGED_WEBP_LOSSY, "image/webp", 5, 3, opts, fakeNativeImage(false, [])),
		).toBeUndefined();
		expect(
			await keepValidImageWithinLimits(damagedPng(), "image/png", 30, 20, opts, fakeNativeImage(false, [])),
		).toBeUndefined();
	});

	it.each([
		["JPEG", "image/jpeg", bytes(JPEG_2X2), 2, 2],
		["GIF", "image/gif", createGif(6, 4, [[0, 0, 6, 4]]), 6, 4],
	])(
		"take the photon path for %s even when the native decoder accepts it",
		async (_name, mimeType, data, width, height) => {
			const log: Uint8Array[] = [];
			expect(
				await keepValidImageWithinLimits(data, mimeType, width, height, opts, fakeNativeImage(true, log)),
			).toBeUndefined();
			expect(log).toEqual([]);
		},
	);

	it("take the photon path without a native decoder", async () => {
		expect(
			await keepValidImageWithinLimits(createPng(300, 200), "image/png", 300, 200, opts, undefined),
		).toBeUndefined();
		expect(await keepValidImageWithinLimits(bytes(JPEG_2X2), "image/jpeg", 2, 2, opts, undefined)).toBeUndefined();
		expect(
			await keepValidImageWithinLimits(bytes(WEBP_LOSSY_5X3), "image/webp", 5, 3, opts, undefined),
		).toBeUndefined();
	});

	it("are not kept when over the limits", async () => {
		const png = createPng(300, 200);
		const small = resolveImageResizeOptions({ maxWidth: 299 });
		expect(
			await keepValidImageWithinLimits(png, "image/png", 300, 200, small, fakeNativeImage(true, [])),
		).toBeUndefined();
	});

	it("use the displayed size of an EXIF-rotated JPEG", () => {
		// 2x1 stored, orientation 6 (rotate 90 degrees): displayed as 1x2.
		const jpeg2x1 = editJpegSegment(bytes(JPEG_2X2), 0xc0, (s) => {
			s.writeUInt16BE(1, 5);
			return s;
		});
		const rotated = Buffer.concat([jpeg2x1.subarray(0, 2), app1Exif(6), jpeg2x1.subarray(2)]);
		expect(readJpegHeader(rotated)).toEqual({ width: 2, height: 1 });
		expect(readDisplayedImageSize(rotated, "image/jpeg")).toEqual({ width: 1, height: 2 });
	});
});

describe("resizeImage with damaged image data (as in 0.9.5: photon rejects it, the image is omitted)", () => {
	const damaged: [string, string, Buffer][] = [
		["JPEG", "image/jpeg", DAMAGED_JPEG],
		["lossless WebP", "image/webp", DAMAGED_WEBP_LOSSLESS],
		["lossy WebP", "image/webp", DAMAGED_WEBP_LOSSY],
		["GIF", "image/gif", damagedGif()],
		["PNG with valid CRCs", "image/png", damagedPng()],
	];

	it.each(damaged)(
		"%s: the header is accepted, photon rejects the data, the result is null",
		async (_name, mimeType, data) => {
			expect(readImageHeader(data, mimeType)).toBeDefined();
			const photon = (await loadPhoton())!;
			expect(() => photon.PhotonImage.new_from_byteslice(data)).toThrow();
			expect(await resizeImage(data, mimeType)).toBeNull();
		},
	);

	it("PNG with a wrong checksum: the header is rejected, the result is null", async () => {
		const png = createPng(30, 20);
		png[png.length - 13] ^= 0xff;
		expect(readPngHeader(png)).toBeUndefined();
		expect(await resizeImage(png, "image/png")).toBeNull();
	});

	it.each([
		["PNG", "image/png", createPng(30, 20).toString("base64")],
		["JPEG", "image/jpeg", JPEG_PROGRESSIVE_5X3],
		["WebP", "image/webp", WEBP_LOSSY_5X3],
	])("an intact %s is returned as it is", async (_name, mimeType, base64) => {
		expect(await resizeImage(bytes(base64), mimeType)).toMatchObject({ data: base64, wasResized: false });
	});
});

describe("resizeImageInProcess", () => {
	beforeEach(() => {
		photonLoads.count = 0;
	});

	it("decodes when the header cannot be read", async () => {
		// Trailing bytes after IEND: the header parser gives up, photon still decodes the file.
		const png = Buffer.concat([createPng(30, 20), Buffer.from("trailer")]);
		expect(readPngHeader(png)).toBeUndefined();

		const result = await resizeImageInProcess(png, "image/png");
		expect(result).toMatchObject({ data: png.toString("base64"), width: 30, height: 20, wasResized: false });
		expect(photonLoads.count).toBe(1);
	});

	it("omits the image when a PNG checksum is wrong", async () => {
		const png = createPng(30, 20);
		png[png.length - 13] ^= 0xff;

		expect(readPngHeader(png)).toBeUndefined();
		expect(await resizeImageInProcess(png, "image/png")).toBeNull();
	});

	it("decodes an image over the limits and encodes only until a candidate fits", async () => {
		const png = createPng(400, 100);
		const result = await resizeImageInProcess(png, "image/png", { maxWidth: 200, maxHeight: 200 });
		expect(result).toMatchObject({
			mimeType: "image/png",
			originalWidth: 400,
			originalHeight: 100,
			width: 200,
			height: 50,
			wasResized: true,
		});
		expect(photonLoads.count).toBe(1);
	});
});
