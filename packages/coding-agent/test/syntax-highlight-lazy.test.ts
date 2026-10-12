import hljs from "highlight.js/lib/core.js";
import { expect, it } from "vitest";
import { highlight, supportsLanguage } from "../src/utils/syntax-highlight.ts";

it("registers the common grammars on first use, not when the module loads", () => {
	expect(hljs.getLanguage("python")).toBeUndefined();
	expect(supportsLanguage("py")).toBe(true);
	expect(hljs.getLanguage("typescript")).toBeDefined();
	expect(highlight("const x = 1;", { language: "ts" })).toContain("const");
});
