import { getCapabilities, type ImageTranscoder, setImageTranscoder } from "@earendil-works/pi-tui";
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

function encodePng(photon: Photon, bytes: Uint8Array): Uint8Array | null {
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		// Conversion failed
		return null;
	}
}

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		// Photon not available, can't convert
		return null;
	}
	return encodePng(photon, bytes);
}

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}

/**
 * Load photon and return a synchronous PNG transcoder for pi-tui's Kitty image rendering.
 * Returns undefined if photon cannot be loaded.
 */
export async function loadPngTranscoder(): Promise<ImageTranscoder | undefined> {
	const photon = await loadPhoton();
	if (!photon) return undefined;
	return (base64Data) => {
		const pngBytes = encodePng(photon, new Uint8Array(Buffer.from(base64Data, "base64")));
		return pngBytes ? Buffer.from(pngBytes).toString("base64") : null;
	};
}

let pngTranscoderLoad: Promise<boolean> | undefined;
let pngTranscoderRegistered = false;

/**
 * On Kitty-protocol terminals, register photon as pi-tui's image transcoder so non-PNG images render.
 * Loads photon once. `onRegistered` runs after registration so callers can re-render images that
 * showed text fallbacks; it is not called if the transcoder was already registered or cannot load.
 */
export function ensurePngTranscoder(onRegistered: () => void): void {
	if (pngTranscoderRegistered || getCapabilities().images !== "kitty") return;
	void loadAndRegisterPngTranscoder().then((registered) => {
		if (registered) onRegistered();
	});
}

function loadAndRegisterPngTranscoder(): Promise<boolean> {
	pngTranscoderLoad ??= loadPngTranscoder().then((transcoder) => {
		if (!transcoder) return false;
		setImageTranscoder(transcoder);
		pngTranscoderRegistered = true;
		return true;
	});
	return pngTranscoderLoad;
}

let firstUseTranscoderInstalled = false;
let firstUseTranscoderCalled = false;
let onFirstUseRegistered: (() => void) | undefined;

/**
 * ensurePngTranscoder() for images nothing has asked for yet: on Kitty-protocol terminals, photon loads the first time a
 * non-PNG image is drawn instead of at startup (it costs startup time and memory). Until it has loaded, such an image is
 * drawn as its text fallback, as it is while ensurePngTranscoder() loads photon. `onRegistered` then runs once to draw the
 * fallbacks again; it is the one pending callback (a later call replaces it) and does not run when no image needed photon.
 */
export function ensurePngTranscoderOnFirstUse(onRegistered: () => void): void {
	onFirstUseRegistered = onRegistered;
	if (pngTranscoderRegistered || firstUseTranscoderInstalled || getCapabilities().images !== "kitty") return;
	firstUseTranscoderInstalled = true;
	setImageTranscoder(() => {
		if (!firstUseTranscoderCalled) {
			firstUseTranscoderCalled = true;
			void loadAndRegisterPngTranscoder().then((registered) => {
				if (registered) onFirstUseRegistered?.();
				// Without photon there is no transcoder, as before.
				else setImageTranscoder(undefined);
			});
		}
		return null;
	});
}
