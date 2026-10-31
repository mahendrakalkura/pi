import { describe, expect, it } from "vitest";
import { loadAllHighlightLanguagesOnDemand, supportsLanguage } from "../src/utils/syntax-highlight.ts";

describe("grammars loaded on demand", () => {
	it("reports only the names asked for before that are languages once all grammars are loaded", async () => {
		// Asked for while drawing a resumed session, before the interactive mode asks to be told.
		expect(supportsLanguage("YAML")).toBe(false);
		expect(supportsLanguage("not-a-language")).toBe(false);
		expect(supportsLanguage("typescript")).toBe(true);

		const reported = await new Promise<ReadonlySet<string>>((resolve) => loadAllHighlightLanguagesOnDemand(resolve));
		expect([...reported]).toEqual(["yaml"]);
		expect(supportsLanguage("yaml")).toBe(true);
		expect(supportsLanguage("not-a-language")).toBe(false);
	});
});
