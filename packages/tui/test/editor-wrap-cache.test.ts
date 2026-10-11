import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	const tui: TUI = new TuiMainScreen(new VirtualTerminal(120, 60));
	return new Editor(tui, defaultEditorTheme);
}

/** What an editor that never rendered before draws for the same text and cursor. */
function freshRender(text: string, width: number, keys: string[] = []): string[] {
	const editor = createEditor();
	editor.setText(text);
	// (Cursor movement uses the width of the last render, as in the editor under test.)
	editor.render(width);
	for (const key of keys) editor.handleInput(key);
	return editor.render(width);
}

const LONG = "The quick brown fox jumps over the lazy dog and keeps running far beyond the edge of the screen";
const TEXT = [LONG, "short line", `${LONG} again, with more words to wrap`, "", LONG].join("\n");

describe("Editor wrap cache", () => {
	it("draws what a fresh editor draws when the width changes back and forth", () => {
		const editor = createEditor();
		editor.setText(TEXT);
		for (const width of [40, 25, 60, 25, 40, 17, 40]) {
			assert.deepStrictEqual(editor.render(width), freshRender(TEXT, width), `width ${width}`);
		}
	});

	it("wraps an edited line again and keeps the others", () => {
		const editor = createEditor();
		editor.setText(TEXT);
		editor.render(30);
		editor.handleInput("x");
		editor.handleInput("y");
		assert.deepStrictEqual(editor.render(30), freshRender(TEXT, 30, ["x", "y"]));
		// Cursor movement across wrapped lines uses the same layout.
		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[A");
		editor.handleInput("z");
		assert.deepStrictEqual(editor.render(30), freshRender(TEXT, 30, ["x", "y", "\x1b[A", "\x1b[A", "z"]));
	});

	it("follows lines inserted and removed before cached lines", () => {
		const editor = createEditor();
		editor.setText(TEXT);
		editor.render(30);
		const shorter = [LONG, LONG].join("\n");
		editor.setText(shorter);
		assert.deepStrictEqual(editor.render(30), freshRender(shorter, 30));
		const longer = ["new first line", TEXT].join("\n");
		editor.setText(longer);
		assert.deepStrictEqual(editor.render(30), freshRender(longer, 30));
	});

	it("wraps paste markers as one unit only while the paste exists", () => {
		const pasted = Array.from({ length: 20 }, (_, i) => `pasted line ${i}`).join("\n");
		const typeWithPaste = (editor: Editor) => {
			editor.handleInput("some words before the pasted text ");
			editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
			editor.handleInput(" and words after the paste marker");
		};
		const editor = createEditor();
		typeWithPaste(editor);
		const reference = createEditor();
		typeWithPaste(reference);
		for (const width of [30, 21, 30]) {
			const lines = editor.render(width);
			assert.ok(
				lines.some((line) => line.includes("[paste #1")),
				"marker shown",
			);
			assert.deepStrictEqual(lines, createEditorWith(typeWithPaste).render(width), `width ${width}`);
		}
		assert.deepStrictEqual(editor.render(21), reference.render(21));

		// The same text with no paste behind the marker: the marker is ordinary text and wraps as words.
		const text = editor.getText();
		editor.setText(text);
		assert.deepStrictEqual(editor.render(21), freshRender(text, 21));
	});
});

function createEditorWith(type: (editor: Editor) => void): Editor {
	const editor = createEditor();
	type(editor);
	return editor;
}
