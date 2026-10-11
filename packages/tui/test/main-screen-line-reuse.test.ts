import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { deleteKittyImage, encodeKitty } from "../src/terminal-image.ts";
import { type Component, Container, markStableRender } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Declared stable, and keeps that promise: a new array whenever its lines change. */
class Stable implements Component {
	private lines: string[];
	constructor(...lines: string[]) {
		this.lines = lines;
	}
	set(...lines: string[]): void {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}
markStableRender(Stable);

class LoggingTerminal extends VirtualTerminal {
	writes = "";
	override write(data: string): void {
		this.writes += data;
		super.write(data);
	}
}

describe("Regular mode reuses finished lines", () => {
	it("draws the same screen as a fresh render after many partial frames", async () => {
		const terminal = new VirtualTerminal(30, 12);
		const tui = new TuiMainScreen(terminal);
		const transcript = new Container();
		const status = new Stable("status 0");
		tui.addChild(transcript);
		tui.addChild(status);
		tui.start();
		for (let i = 0; i < 8; i++) {
			transcript.addChild(new Text(`entry ${i}\tend`, 0, 0));
			status.set(`status ${i}`);
			tui.requestRender();
			await terminal.waitForRender();
		}
		const viewport = await terminal.flushAndGetViewport();
		tui.stop();

		const freshTerminal = new VirtualTerminal(30, 12);
		const freshTui = new TuiMainScreen(freshTerminal);
		const freshTranscript = new Container();
		for (let i = 0; i < 8; i++) freshTranscript.addChild(new Text(`entry ${i}\tend`, 0, 0));
		freshTui.addChild(freshTranscript);
		freshTui.addChild(new Stable("status 7"));
		freshTui.start();
		await freshTerminal.waitForRender();
		assert.deepStrictEqual(viewport, await freshTerminal.flushAndGetViewport());
		freshTui.stop();
	});

	it("still deletes and redraws Kitty images when lines around them stay the same", async () => {
		const terminal = new LoggingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 91, moveCursor: false });
		const content = new Stable("text above", image, "", "text below");
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.writes.includes(image), "image drawn");

		terminal.writes = "";
		content.set("text above", image, "", "changed below");
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(!terminal.writes.includes(deleteKittyImage(91)), "an image whose rows did not change stays");

		terminal.writes = "";
		content.set("changed above", "plain", "", "changed below");
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(terminal.writes.includes(deleteKittyImage(91)), "a replaced image is deleted");

		terminal.writes = "";
		content.set("changed above", "plain", "", "again");
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(!terminal.writes.includes("\x1b_G"), "no image left to delete or draw");
		tui.stop();
	});
});
