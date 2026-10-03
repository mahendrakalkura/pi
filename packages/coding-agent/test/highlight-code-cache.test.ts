import { beforeAll, describe, expect, it } from "vitest";
import {
	getMarkdownTheme,
	getThemeByName,
	highlightCode,
	initTheme,
	setThemeInstance,
} from "../src/modes/interactive/theme/theme.ts";

// Highlighted code is kept by language and text, for the theme in use. What comes back must be what highlighting gives.

const CODE = 'export function add(a: number, b: number): number {\n\treturn a + b; // "sum"\n}';

describe("highlightCode keeps what it highlighted", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("gives the same lines again, in an array of the caller's own", () => {
		const first = highlightCode(CODE, "typescript");
		expect(first.length).toBe(3);
		expect(first.join("\n")).toContain("\x1b[");
		first[0] = "changed by the caller";
		first.push("added by the caller");
		const second = highlightCode(CODE, "typescript");
		expect(second.length).toBe(3);
		expect(second[0]).not.toBe("changed by the caller");
		expect(highlightCode(CODE, "typescript")).toEqual(second);
		// The Markdown theme highlights the same way.
		expect(getMarkdownTheme().highlightCode?.(CODE, "typescript")).toEqual(second);
	});

	it("keeps languages apart, and leaves code in no known language alone", () => {
		const asTypeScript = highlightCode(CODE, "typescript");
		const asPython = highlightCode(CODE, "python");
		expect(asPython).not.toEqual(asTypeScript);
		expect(highlightCode(CODE, "typescript")).toEqual(asTypeScript);
		const unknown = highlightCode(CODE, "no-such-language");
		expect(unknown.length).toBe(3);
		expect(highlightCode(CODE)).toEqual(unknown);
	});

	it("highlights again for another theme", () => {
		const dark = highlightCode(CODE, "typescript");
		const light = getThemeByName("light");
		expect(light).toBeDefined();
		setThemeInstance(light as NonNullable<typeof light>);
		const inLight = highlightCode(CODE, "typescript");
		expect(inLight).not.toEqual(dark);
		initTheme("dark");
		expect(highlightCode(CODE, "typescript")).toEqual(dark);
	});

	it("a block that grows, as when it streams in, is highlighted as it is at each length", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `const value${i} = compute(${i}); // step ${i}`);
		const text = lines.join("\n");
		const whole = highlightCode(text, "javascript");
		for (let length = 10; length < text.length; length += 37) {
			const partial = text.slice(0, length);
			const highlighted = highlightCode(partial, "javascript");
			expect(highlighted.length).toBe(partial.split("\n").length);
			// Again, from what was kept.
			expect(highlightCode(partial, "javascript")).toEqual(highlighted);
		}
		expect(highlightCode(text, "javascript")).toEqual(whole);
	});

	it("many different blocks: still right when the oldest have been dropped", () => {
		const blocks = Array.from({ length: 200 }, (_, i) => `let x${i} = ${i};\nconsole.log(x${i});`);
		const first = blocks.map((block) => highlightCode(block, "javascript"));
		const again = blocks.map((block) => highlightCode(block, "javascript"));
		expect(again).toEqual(first);
	});
});
