import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { writeZipArchive } from "../src/utils/zip.ts";

describe("writeZipArchive", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("writes deflated entries with their CRC-32", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-zip-"));
		const file = join(dir, "a.zip");
		const text = "hello zip\n".repeat(50);
		await writeZipArchive(file, [{ name: "a.txt", data: text }]);
		const zip = readFileSync(file);
		expect(zip.readUInt32LE(0)).toBe(0x04034b50);
		expect(zip.readUInt32LE(14)).toBe(crc32(Buffer.from(text)));
		const compressedSize = zip.readUInt32LE(18);
		const nameLength = zip.readUInt16LE(26);
		const extraLength = zip.readUInt16LE(28);
		const start = 30 + nameLength + extraLength;
		expect(zip.subarray(30, 30 + nameLength).toString()).toBe("a.txt");
		expect(inflateRawSync(zip.subarray(start, start + compressedSize)).toString()).toBe(text);
	});
});
