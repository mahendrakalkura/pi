import * as undici from "undici";
import { describe, expect, it, vi } from "vitest";
import type * as Config from "../src/config.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Config>()),
	isBunRuntime: true,
}));

describe("http dispatcher on Bun", () => {
	it("leaves the global dispatcher and fetch alone", () => {
		const dispatcher = undici.getGlobalDispatcher();
		const fetch = globalThis.fetch;
		configureHttpDispatcher(60_000);
		expect(undici.getGlobalDispatcher()).toBe(dispatcher);
		expect(globalThis.fetch).toBe(fetch);
	});

	it("still rejects an invalid timeout", () => {
		expect(() => configureHttpDispatcher(-1)).toThrow("Invalid HTTP idle timeout: -1");
	});
});
