import type * as Tui from "@earendil-works/pi-tui";
import type { ImageTranscoder } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ImageConvert from "../src/utils/image-convert.ts";

const setImageTranscoder = vi.hoisted(() => vi.fn<(transcoder: ImageTranscoder | undefined) => void>());
const loadPhoton = vi.hoisted(() => vi.fn<() => Promise<object | null>>());

vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
	...(await importOriginal<typeof Tui>()),
	getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: true }),
	setImageTranscoder,
}));
vi.mock("../src/utils/photon.ts", () => ({ loadPhoton }));

async function freshModule(): Promise<typeof ImageConvert> {
	vi.resetModules();
	return import("../src/utils/image-convert.ts");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("ensurePngTranscoderOnFirstUse", () => {
	beforeEach(() => {
		setImageTranscoder.mockReset();
		loadPhoton.mockReset();
	});

	it("loads photon only when an image needs it and redraws once", async () => {
		const { ensurePngTranscoderOnFirstUse } = await freshModule();
		const photon = deferred<object | null>();
		loadPhoton.mockReturnValue(photon.promise);
		const first = vi.fn();
		const second = vi.fn();

		ensurePngTranscoderOnFirstUse(first);
		ensurePngTranscoderOnFirstUse(second);
		expect(loadPhoton).not.toHaveBeenCalled();
		expect(setImageTranscoder).toHaveBeenCalledTimes(1);

		const standIn = setImageTranscoder.mock.calls[0][0]!;
		expect(standIn("AAAA", "image/jpeg")).toBeNull();
		expect(standIn("BBBB", "image/jpeg")).toBeNull();
		expect(loadPhoton).toHaveBeenCalledTimes(1);

		photon.resolve({});
		await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
		expect(first).not.toHaveBeenCalled();
		expect(setImageTranscoder).toHaveBeenCalledTimes(2);
		expect(setImageTranscoder.mock.calls[1][0]).toBeTypeOf("function");
		expect(setImageTranscoder.mock.calls[1][0]).not.toBe(standIn);

		// Registered: nothing more to install.
		ensurePngTranscoderOnFirstUse(first);
		expect(setImageTranscoder).toHaveBeenCalledTimes(2);
	});

	it("shares the load with ensurePngTranscoder", async () => {
		const { ensurePngTranscoder, ensurePngTranscoderOnFirstUse } = await freshModule();
		loadPhoton.mockResolvedValue({});
		const redraw = vi.fn();
		const toolRedraw = vi.fn();
		ensurePngTranscoderOnFirstUse(redraw);
		ensurePngTranscoder(toolRedraw);
		await vi.waitFor(() => expect(toolRedraw).toHaveBeenCalledTimes(1));
		expect(loadPhoton).toHaveBeenCalledTimes(1);
		// No image went through the stand-in: no redraw needed.
		expect(redraw).not.toHaveBeenCalled();
	});

	it("removes the stand-in when photon cannot load", async () => {
		const { ensurePngTranscoderOnFirstUse } = await freshModule();
		loadPhoton.mockResolvedValue(null);
		const redraw = vi.fn();
		ensurePngTranscoderOnFirstUse(redraw);
		const standIn = setImageTranscoder.mock.calls[0][0]!;
		expect(standIn("AAAA", "image/jpeg")).toBeNull();
		await vi.waitFor(() => expect(setImageTranscoder).toHaveBeenCalledTimes(2));
		expect(setImageTranscoder.mock.calls[1][0]).toBeUndefined();
		expect(redraw).not.toHaveBeenCalled();
		ensurePngTranscoderOnFirstUse(redraw);
		expect(setImageTranscoder).toHaveBeenCalledTimes(2);
	});
});
