import assert from "node:assert";
import { describe, it } from "node:test";
import { lexMarkdownForTest, Markdown, setMarkdownCachingForTest } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

// A message that streams in is lexed again each time it grows, from the last block on. The tokens must be what lexing all of
// it gives, at every length it passes through.

const DOCUMENTS: Record<string, string> = {
	everything: `# Title

Intro paragraph with **bold**, *italic*, \`code\`, ~~gone~~ and a [link](https://example.com).
A second line of the same paragraph.

Setext heading
==============

Another one
-----------

- item one
- item two
  continued lazily
  - nested item
    1. deeper, numbered

- loose item after a blank line

1. first
2. second
   \`\`\`js
   const inList = 1;
   \`\`\`
3. third

- [ ] task open
- [x] task done

> quote line one
lazy continuation
> > nested quote
> - list in quote

\`\`\`ts
export function f(a: number): number {
	return a + 1; // \`not a fence\`
}
\`\`\`

~~~python
def g():
    return "~~~ inside"
~~~

    indented code
    second line

Paragraph right before a table
| a | b |
|---|:-:|
| 1 | 2 |
| 3 | 4 |

text | that | looks like a table
but is not

<div align="center">
html block
</div>

***

Line with trailing spaces  
hard break, and a backslash\\
break. An autolink https://example.org/x?y=1 and <mailto:a@b.c>.

$$
E = mc^2
$$

Inline math $a^2 + b^2$ and \\(x_1\\), then \\[ y = 2x \\] at the end.

![image](https://example.com/i.png "title")

Final paragraph.
`,
	crlf: "one\r\ntwo\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n```\r\nend",
	lonecr: "one\rtwo\r\rthree",
	tabs: "a\tb\t\n\n-\tx\ty\n\n```\n\tcode\twith\ttabs\n\t\n```\n\n\ttab-indented\n\n|\ta\t|\tb\t|\n|---|---|\n|\t1\t|\t2\t|\n\nend\t",
	references: `A [ref][one] before its definition, and [another].

Some text in between.

[one]: https://example.com/one
[another]: https://example.com/two "Two"

After the definitions: [ref][one] again.
`,
	fences: "start\n\n```\nunclosed code\nwith `` two ticks\n``",
	fenceInList: "- item\n  ```sh\n  ls\n  ``",
	blanks: "a\n\n\n\nb\n\n   \n\nc\n \n",
	onlyList: "- a\n- b\n\n- c\n\n  para in c\n- d",
	listThenBlank: "- a\n- b\n\n\n- c\n\nnot a list\n\n1. x\n\n2. y",
	headingsOnly: "# a\n## b\n### c\n\n#### d\ntext\n# e",
	unicode: "naïve café — 日本語 😀\n\n- 🇮🇳 flag\n- zero\u200bwidth\n\n| 列 | 值 |\n|---|---|\n| 一 | 二 |\n",
	pendingMath: "Compute:\n\n\\[\nx = \\frac{1}{2}\n",
	hrAndSetext: "para\n---\n\npara\n\n---\n\n* * *\ntext\n===",
	htmlInline: "a <b>bold</b> <!-- comment --> b\n\n<details>\n<summary>s</summary>\n\nbody\n\n</details>\n\nafter",
};

function random(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
		return state / 4294967296;
	};
}

function streamAndCompare(name: string, text: string, sizes: () => number): void {
	// A prefix of its own, so that nothing kept from another test is taken up.
	const document = `<!-- ${name} ${Math.random()} -->\n\n${text}`;
	for (let length = Math.min(30, document.length); ; length = Math.min(document.length, length + sizes())) {
		const source = document.slice(0, length);
		const incremental = JSON.stringify(lexMarkdownForTest(source));
		// As a message is rendered while it streams in: a new component each time, at the width of the terminal.
		const rendered = new Markdown(source, 1, 0, defaultMarkdownTheme).render(72);
		setMarkdownCachingForTest(false);
		const fresh = JSON.stringify(lexMarkdownForTest(source));
		const renderedFresh = new Markdown(source, 1, 0, defaultMarkdownTheme).render(72);
		setMarkdownCachingForTest(true);
		if (incremental !== fresh) {
			assert.strictEqual(
				incremental,
				fresh,
				`${name}: tokens differ at length ${length}: ${JSON.stringify(source.slice(-60))}`,
			);
		}
		assert.deepStrictEqual(rendered, renderedFresh, `${name}: rendered lines differ at length ${length}`);
		if (length >= document.length) {
			break;
		}
	}
}

describe("Markdown lexing of a growing source", () => {
	for (const [name, text] of Object.entries(DOCUMENTS)) {
		it(`${name}: one character at a time`, () => {
			streamAndCompare(name, text, () => 1);
		});
		it(`${name}: chunks of random sizes`, () => {
			for (let seed = 1; seed <= 5; seed++) {
				const next = random(seed);
				streamAndCompare(`${name}#${seed}`, text, () => 1 + Math.floor(next() * 40));
			}
		});
	}

	it("random documents made of blocks in random order", () => {
		const blocks = Object.values(DOCUMENTS)
			.join("\n\n")
			.split(/\n{2,}/)
			.filter((block) => block.trim());
		for (let seed = 1; seed <= 40; seed++) {
			const next = random(seed * 7919);
			let text = "";
			for (let i = 0; i < 25; i++) {
				text += blocks[Math.floor(next() * blocks.length)] + (next() < 0.8 ? "\n\n" : "\n");
			}
			streamAndCompare(`random#${seed}`, text, seed % 4 === 0 ? () => 1 : () => 1 + Math.floor(next() * 60));
		}
	});

	it("every kind of block after every kind of block, one character at a time", () => {
		const before = [
			"- a\n- b",
			"1. x\n2. y",
			"1. x",
			"- a\n\n  more of a",
			"> quoted\n> more",
			"a paragraph\nof two lines",
			"```js\ncode\n```",
			"    indented code",
			"| a | b |\n|---|---|\n| 1 | 2 |",
			"## heading",
			"<div>\nhtml\n</div>",
			"---",
			"$$\nx^2\n$$",
			"- [ ] task",
		];
		const between = ["\n", "\n\n", "\n\n\n", "\n \n"];
		const after = [
			"2. y\nz",
			"3. y",
			"- z\n\n- w",
			"* z",
			"+ p",
			"> q\nlazy",
			"    code\n    more",
			"  indented text",
			"===",
			"---",
			"***",
			"| c | d |\n|---|---|\n| 3 | 4 |",
			"| c | d |",
			"```\nfenced\n```\nend",
			"~~~",
			"plain text\n===",
			"1) x",
			"# h",
			"<b>x</b>",
			"\\[ x \\]",
			"$$ y $$",
			"[label]: https://example.com\n\n[label]",
			"- [x] done",
			"10. ten",
			"-",
			"2.",
		];
		for (const first of before) {
			for (const gap of between) {
				for (const second of after) {
					streamAndCompare(
						JSON.stringify([first, gap, second]),
						`start\n\n${first}${gap}${second}\n\nend`,
						() => 1,
					);
				}
			}
		}
	});

	it("the blocks before the last two are not lexed again", () => {
		const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} of a long answer.`);
		let source = `<!-- reuse ${Math.random()} -->`;
		let previous = lexMarkdownForTest(source);
		let reused = 0;
		for (const paragraph of paragraphs) {
			source += `\n\n${paragraph}`;
			const tokens = lexMarkdownForTest(source);
			// All but the last two blocks (and the blank lines between them) are the token objects of the time before.
			for (let i = 0; i < previous.length - 4; i++) {
				assert.strictEqual(tokens[i], previous[i]);
				reused++;
			}
			previous = tokens;
		}
		assert.ok(reused > 500, `only ${reused} tokens were reused`);
	});

	it("a source that is not the earlier one with text added is lexed whole", () => {
		const first = lexMarkdownForTest("# replaced\n\nfirst version of the paragraph\n\ntail");
		const source = "# replaced\n\nanother version\n\ntail";
		const second = lexMarkdownForTest(source);
		assert.notStrictEqual(first, second);
		setMarkdownCachingForTest(false);
		const fresh = lexMarkdownForTest(source);
		setMarkdownCachingForTest(true);
		assert.strictEqual(JSON.stringify(second), JSON.stringify(fresh));
		// The same source again: the same tokens.
		assert.strictEqual(lexMarkdownForTest(source), second);
	});

	it("blocks are rendered again for another width, style or theme, and after invalidate()", () => {
		const source = `<!-- styles ${Math.random()} -->\n\n# Heading\n\nSome *text* that is long enough to be wrapped when the width is small.\n\n- a\n- b\n\nlast`;
		const cold = (render: () => string[]) => {
			setMarkdownCachingForTest(false);
			const lines = render();
			setMarkdownCachingForTest(true);
			return lines;
		};
		const upper = { ...defaultMarkdownTheme, heading: (text: string) => `<<${text.toUpperCase()}>>` };
		const renders: Array<() => string[]> = [
			() => new Markdown(source, 1, 0, defaultMarkdownTheme).render(72),
			() => new Markdown(source, 1, 0, defaultMarkdownTheme).render(30),
			() => new Markdown(source, 3, 1, defaultMarkdownTheme).render(72),
			() => new Markdown(source, 1, 0, upper).render(72),
			() =>
				new Markdown(source, 1, 0, defaultMarkdownTheme, { italic: true, color: (text) => `{${text}}` }).render(72),
			() => new Markdown(source, 1, 0, defaultMarkdownTheme, { bgColor: (text) => `[${text}]` }).render(72),
			() =>
				new Markdown(source, 1, 0, defaultMarkdownTheme, undefined, { preserveOrderedListMarkers: true }).render(
					72,
				),
		];
		// Each after each of the others, so that what one left behind is there for the next to take wrongly.
		for (const first of renders) {
			for (const second of renders) {
				first();
				assert.deepStrictEqual(second(), cold(second));
			}
		}

		// A theme whose functions change what they give: invalidate() is how a component is told.
		let mark = "a";
		const changing = { ...defaultMarkdownTheme, heading: (text: string) => `${mark}:${text}` };
		const component = new Markdown(source, 1, 0, changing);
		const before = component.render(72).join("\n");
		mark = "b";
		component.invalidate();
		const after = new Markdown(source, 1, 0, changing).render(72).join("\n");
		assert.ok(before.includes("a:") && !before.includes("b:"));
		assert.ok(after.includes("b:") && !after.includes("a:"));
	});
});
