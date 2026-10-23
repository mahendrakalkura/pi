import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { type Component, setRenderClockForTest } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// When frames are slow, the next frame starts no sooner than three times the last frame's duration after the last one
// started, so drawing takes at most about a third of the thread. Frames that are not slow are scheduled as before; input
// is handled at once; the last frame of a burst is always drawn; the first frame, a resize and a forced redraw are drawn
// as soon as before. A fake clock: each frame takes `cost` milliseconds of it.

let now = 0;

/** A component whose render takes `cost` ms of the fake clock; records when each frame started and what it showed. */
class Timed implements Component {
	cost: number;
	text = "start";
	starts: number[] = [];
	shown: string[] = [];
	inputs: Array<{ data: string; at: number }> = [];
	constructor(cost: number) {
		this.cost = cost;
	}
	render(_width: number): string[] {
		this.starts.push(now);
		this.shown.push(this.text);
		now += this.cost;
		return [this.text];
	}
	handleInput(data: string): void {
		this.inputs.push({ data, at: now });
		this.text = data;
	}
	invalidate(): void {}
}

async function ticks(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => process.nextTick(resolve));
}

/** Advances the fake clock and the timers by `ms`, a millisecond at a time. */
async function advance(ms: number, each?: () => void): Promise<void> {
	for (let i = 0; i < ms; i++) {
		// (Requests schedule their frame on the next tick: before the clock moves on.)
		await ticks();
		now += 1;
		mock.timers.tick(1);
		each?.();
		await ticks();
	}
}

function setup(cost: number): { tui: TuiMainScreen; terminal: VirtualTerminal; component: Timed } {
	const terminal = new VirtualTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	const component = new Timed(cost);
	tui.addChild(component);
	tui.setFocus(component);
	return { tui, terminal, component };
}

function gaps(starts: number[]): number[] {
	return starts.slice(1).map((start, i) => start - starts[i]!);
}

describe("frame spacing", () => {
	beforeEach(() => {
		now = 1000;
		setRenderClockForTest(() => now);
		mock.timers.enable({ apis: ["setTimeout"] });
	});
	afterEach(() => {
		mock.timers.reset();
		setRenderClockForTest(undefined);
	});

	it("schedules frames that are not slow as before: 16 ms apart, input at once", async () => {
		const { tui, component } = setup(2);
		tui.start();
		await advance(20);
		component.starts = [];
		await advance(200, () => tui.requestRender());
		assert.ok(component.starts.length >= 11, `${component.starts.length} frames`);
		for (const gap of gaps(component.starts)) assert.strictEqual(gap, 16);
		// A key 3 ms after a frame: its frame is drawn at once (no 16 ms wait), as before.
		const before = component.starts.length;
		await advance(3);
		const at = now;
		(tui.terminal as VirtualTerminal).sendInput("k");
		await ticks();
		assert.strictEqual(component.starts.length, before + 1);
		assert.strictEqual(component.starts.at(-1), at);
		tui.stop();
	});

	it("starts a slow frame no sooner than three times the last one's duration after it", async () => {
		const { tui, component } = setup(30);
		tui.start();
		await advance(20);
		component.starts = [];
		const begin = now;
		await advance(2000, () => tui.requestRender());
		const frames = component.starts.length;
		for (const gap of gaps(component.starts)) assert.ok(gap >= 90 && gap <= 91, `gap ${gap}`);
		// (Drawing takes about a third of the thread.)
		const busy = (frames * 30) / (now - begin);
		assert.ok(busy <= 0.34, `busy ${busy}`);
		assert.ok(frames >= 18, `${frames} frames`);
		tui.stop();
	});

	it("always draws the last frame of a burst, with the latest content", async () => {
		const { tui, component } = setup(30);
		tui.start();
		await advance(20);
		component.starts = [];
		component.shown = [];
		tui.requestRender();
		await advance(1);
		const first = component.starts[0]!;
		component.text = "one";
		tui.requestRender();
		await advance(10);
		component.text = "two";
		tui.requestRender();
		await advance(300);
		assert.deepStrictEqual(component.shown, ["start", "two"]);
		assert.strictEqual(component.starts[1]! - first, 90);
		tui.stop();
	});

	it("handles input at once, and draws its frame no later than the spacing", async () => {
		const { tui, terminal, component } = setup(30);
		tui.start();
		await advance(20);
		tui.requestRender();
		await advance(1);
		const last = component.starts.at(-1)!;
		await advance(10);
		const sent = now;
		terminal.sendInput("x");
		// (Handled at once, before any frame.)
		assert.deepStrictEqual(component.inputs, [{ data: "x", at: sent }]);
		await advance(200);
		const frame = component.starts.find((start) => start > last)!;
		assert.strictEqual(frame - last, 90);
		assert.strictEqual(component.shown.at(-1), "x");
		// Keystroke to screen: at most the spacing, here 90 - 10 ms after the key.
		assert.ok(frame - sent <= 90, `latency ${frame - sent}`);
		tui.stop();
	});

	it("draws a resize and a forced redraw as soon as before, and the first frame", async () => {
		const { tui, terminal, component } = setup(30);
		tui.start();
		await advance(1);
		assert.strictEqual(component.starts.length, 1, "the first frame");
		await advance(100);
		tui.requestRender();
		await advance(1);
		const last = component.starts.at(-1)!;
		terminal.resize(50, 10);
		await advance(40);
		const resized = component.starts.find((start) => start > last)!;
		assert.ok(resized - last <= 31, `resize drawn ${resized - last} ms after the frame before`);
		await advance(5);
		const count = component.starts.length;
		tui.requestRender(true);
		await ticks();
		assert.strictEqual(component.starts.length, count + 1, "the forced redraw at once");
		tui.stop();
	});
});
