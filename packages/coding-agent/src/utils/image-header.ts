/**
 * Width and height of an image, read from its file structure without decoding pixels.
 *
 * Resizing needs the dimensions only to decide whether an image already fits the limits. Decoding a
 * whole screenshot for that costs about a second in photon's WebAssembly when it runs interpreted.
 *
 * The parsers are strict on purpose: they return undefined for anything they do not fully
 * understand (unknown chunk layout, truncation, bad PNG checksums, uncommon JPEG codings), and the
 * caller then takes the full decode path as before. A file is accepted only when its structure is
 * intact from the signature to the end marker.
 */
export interface ImageHeader {
	width: number;
	height: number;
}

// node:zlib loads on first use, not at every start.
function crc32(data: Uint8Array): number {
	return process.getBuiltinModule("node:zlib").crc32(data);
}

function u16be(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32be(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function u16le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32le(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
	if (offset + text.length > bytes.length) return false;
	for (let i = 0; i < text.length; i++) {
		if (bytes[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bit depths the PNG specification allows for each colour type. */
const PNG_BIT_DEPTHS: Record<number, number[]> = {
	0: [1, 2, 4, 8, 16],
	2: [8, 16],
	3: [1, 2, 4, 8],
	4: [8, 16],
	6: [8, 16],
};

function isChunkTypeByte(byte: number): boolean {
	return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

/**
 * PNG: every chunk is walked and its CRC checked (decoders reject a bad CRC), IHDR must come first
 * with valid fields, IDAT must be present (after PLTE for palette images), and IEND must end the file.
 */
export function readPngHeader(bytes: Uint8Array): ImageHeader | undefined {
	if (bytes.length < PNG_SIGNATURE.length + 25 + 12 + 12) return undefined;
	for (let i = 0; i < PNG_SIGNATURE.length; i++) {
		if (bytes[i] !== PNG_SIGNATURE[i]) return undefined;
	}

	let header: ImageHeader | undefined;
	let colorType = -1;
	let sawPalette = false;
	let sawData = false;
	let offset = PNG_SIGNATURE.length;
	while (offset + 12 <= bytes.length) {
		const length = u32be(bytes, offset);
		if (length > 0x7fffffff) return undefined;
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > bytes.length) return undefined;
		for (let i = 4; i < 8; i++) {
			if (!isChunkTypeByte(bytes[offset + i])) return undefined;
		}
		if (crc32(bytes.subarray(offset + 4, dataEnd)) !== u32be(bytes, dataEnd)) return undefined;

		const isFirst = offset === PNG_SIGNATURE.length;
		const isHeader = asciiAt(bytes, offset + 4, "IHDR");
		if (isFirst !== isHeader) return undefined;
		if (isHeader) {
			if (length !== 13) return undefined;
			const width = u32be(bytes, dataStart);
			const height = u32be(bytes, dataStart + 4);
			const bitDepth = bytes[dataStart + 8];
			colorType = bytes[dataStart + 9];
			const compression = bytes[dataStart + 10];
			const filter = bytes[dataStart + 11];
			const interlace = bytes[dataStart + 12];
			if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return undefined;
			if (!PNG_BIT_DEPTHS[colorType]?.includes(bitDepth)) return undefined;
			if (compression !== 0 || filter !== 0 || interlace > 1) return undefined;
			header = { width, height };
		} else if (asciiAt(bytes, offset + 4, "PLTE")) {
			if (sawData) return undefined;
			sawPalette = true;
		} else if (asciiAt(bytes, offset + 4, "IDAT")) {
			if (colorType === 3 && !sawPalette) return undefined;
			sawData = true;
		} else if (asciiAt(bytes, offset + 4, "IEND")) {
			// IEND must be empty and end the file.
			if (length !== 0 || dataEnd + 4 !== bytes.length || !sawData) return undefined;
			return header;
		}
		offset = dataEnd + 4;
	}
	return undefined;
}

/**
 * JPEG: the marker segments before the first scan are walked, there must be exactly one baseline,
 * extended or progressive Huffman frame header (SOF0-SOF2) with 8-bit samples and 1 or 3
 * components, and the file must end with the EOI marker. Lossless, arithmetic-coded, 12-bit and
 * CMYK files take the decode path.
 */
export function readJpegHeader(bytes: Uint8Array): ImageHeader | undefined {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
	if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return undefined;

	let header: ImageHeader | undefined;
	let offset = 2;
	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) return undefined;
		// Any number of 0xff fill bytes may precede a marker.
		while (offset < bytes.length && bytes[offset] === 0xff) offset++;
		if (offset >= bytes.length) return undefined;
		const marker = bytes[offset];
		offset++;
		// Markers without a segment (TEM, RSTn, SOI, EOI) cannot appear before the first scan.
		if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return undefined;
		if (offset + 2 > bytes.length) return undefined;
		const length = u16be(bytes, offset);
		if (length < 2 || offset + length > bytes.length) return undefined;

		if (marker === 0xda) {
			// Start of scan: the frame header must have come first.
			return header;
		}
		// C0-CF other than DHT (C4) are frame headers, JPG (C8) or DAC (CC). Only SOF0-SOF2 are accepted.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4) {
			if (header || marker > 0xc2 || length < 8) return undefined;
			const precision = bytes[offset + 2];
			const height = u16be(bytes, offset + 3);
			const width = u16be(bytes, offset + 5);
			const components = bytes[offset + 7];
			if (precision !== 8 || width === 0 || height === 0) return undefined;
			if (components !== 1 && components !== 3) return undefined;
			if (length !== 8 + components * 3) return undefined;
			header = { width, height };
		}
		offset += length;
	}
	return undefined;
}

function skipGifSubBlocks(bytes: Uint8Array, offset: number): number {
	while (offset < bytes.length) {
		const size = bytes[offset];
		offset += 1 + size;
		if (size === 0) return offset;
	}
	return -1;
}

/**
 * GIF: the logical screen size, after walking every block to the trailer. Each frame must lie
 * within the logical screen, and the trailer must end the file.
 */
export function readGifHeader(bytes: Uint8Array): ImageHeader | undefined {
	if (bytes.length < 14 || !(asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a"))) return undefined;
	const width = u16le(bytes, 6);
	const height = u16le(bytes, 8);
	if (width === 0 || height === 0) return undefined;
	const screenFlags = bytes[10];
	let offset = 13;
	if (screenFlags & 0x80) offset += 3 * (1 << ((screenFlags & 0x07) + 1));

	let frames = 0;
	while (offset < bytes.length) {
		const block = bytes[offset];
		if (block === 0x3b) {
			return frames > 0 && offset + 1 === bytes.length ? { width, height } : undefined;
		}
		if (block === 0x21) {
			if (offset + 2 > bytes.length) return undefined;
			offset = skipGifSubBlocks(bytes, offset + 2);
		} else if (block === 0x2c) {
			if (offset + 10 > bytes.length) return undefined;
			const left = u16le(bytes, offset + 1);
			const top = u16le(bytes, offset + 3);
			const frameWidth = u16le(bytes, offset + 5);
			const frameHeight = u16le(bytes, offset + 7);
			const frameFlags = bytes[offset + 9];
			if (frameWidth === 0 || frameHeight === 0 || left + frameWidth > width || top + frameHeight > height) {
				return undefined;
			}
			offset += 10;
			if (frameFlags & 0x80) offset += 3 * (1 << ((frameFlags & 0x07) + 1));
			if (offset >= bytes.length) return undefined;
			const minCodeSize = bytes[offset];
			if (minCodeSize < 2 || minCodeSize > 8) return undefined;
			offset = skipGifSubBlocks(bytes, offset + 1);
			frames++;
		} else {
			return undefined;
		}
		if (offset < 0) return undefined;
	}
	return undefined;
}

/**
 * WebP: the RIFF size must match the file and every chunk must fit. The file is either one lossy
 * (VP8) or lossless (VP8L) bitstream, or an extended (VP8X) canvas with one bitstream of the canvas
 * size. Animated files take the decode path.
 */
export function readWebpHeader(bytes: Uint8Array): ImageHeader | undefined {
	if (bytes.length < 20 || !asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) return undefined;
	if (u32le(bytes, 4) + 8 !== bytes.length) return undefined;

	let canvas: ImageHeader | undefined;
	let frame: ImageHeader | undefined;
	let offset = 12;
	while (offset < bytes.length) {
		if (offset + 8 > bytes.length) return undefined;
		const size = u32le(bytes, offset + 4);
		const dataStart = offset + 8;
		const dataEnd = dataStart + size;
		if (dataEnd > bytes.length) return undefined;
		const isFirst = offset === 12;
		// Without a VP8X header, the file is a single VP8 or VP8L chunk.
		if (!isFirst && !canvas) return undefined;

		if (asciiAt(bytes, offset, "VP8 ") || asciiAt(bytes, offset, "VP8L")) {
			if (frame) return undefined;
			frame = readWebpBitstreamSize(bytes, offset, dataStart, size);
			if (!frame) return undefined;
		} else if (asciiAt(bytes, offset, "VP8X")) {
			if (!isFirst || size < 10) return undefined;
			canvas = { width: u24le(bytes, dataStart + 4) + 1, height: u24le(bytes, dataStart + 7) + 1 };
		} else if (isFirst || asciiAt(bytes, offset, "ANIM") || asciiAt(bytes, offset, "ANMF")) {
			return undefined;
		}
		// Chunks are padded to an even size.
		offset = dataEnd + (size & 1);
	}
	if (offset !== bytes.length || !frame) return undefined;
	// An extended file's one bitstream must fill the canvas.
	if (canvas && (frame.width !== canvas.width || frame.height !== canvas.height)) return undefined;
	return frame;
}

function readWebpBitstreamSize(
	bytes: Uint8Array,
	chunkOffset: number,
	dataStart: number,
	size: number,
): ImageHeader | undefined {
	if (asciiAt(bytes, chunkOffset, "VP8L")) {
		// Signature 0x2f, then 14-bit width-1 and height-1, an alpha hint bit and a 3-bit version (0).
		if (size < 5 || bytes[dataStart] !== 0x2f) return undefined;
		const bits = u32le(bytes, dataStart + 1);
		if (bits >>> 29 !== 0) return undefined;
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
	}
	// VP8: 3-byte frame tag (key frame flag clear), start code 9d 01 2a, then 14-bit width and height.
	if (size < 10 || (bytes[dataStart] & 0x01) !== 0) return undefined;
	if (bytes[dataStart + 3] !== 0x9d || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) {
		return undefined;
	}
	const width = u16le(bytes, dataStart + 6) & 0x3fff;
	const height = u16le(bytes, dataStart + 8) & 0x3fff;
	return width === 0 || height === 0 ? undefined : { width, height };
}

/**
 * Dimensions from the header of a well-formed PNG, JPEG, GIF or WebP file, as stored (before any
 * EXIF orientation). Undefined when the format is unknown or the structure is not fully understood.
 */
export function readImageHeader(bytes: Uint8Array, mimeType: string): ImageHeader | undefined {
	switch (mimeType) {
		case "image/png":
			return readPngHeader(bytes);
		case "image/jpeg":
			return readJpegHeader(bytes);
		case "image/gif":
			return readGifHeader(bytes);
		case "image/webp":
			return readWebpHeader(bytes);
		default:
			return undefined;
	}
}
