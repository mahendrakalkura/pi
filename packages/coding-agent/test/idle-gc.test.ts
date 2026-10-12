import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleCollector, runtimeFullCollection } from "../src/core/idle-gc.ts";

const MB = 1024 * 1024;

function setup(options: { busy?: boolean } = {}) {
	let heap = 100 * MB;
	let busy = options.busy ?? false;
	let activity: (() => void) | undefined;
	const collect = vi.fn(() => {
		heap = 60 * MB;
	});
	const unwatch = vi.fn(() => {
		activity = undefined;
	});
	const collector = new IdleCollector({
		collect,
		heapBytes: () => heap,
		isBusy: () => busy,
		watchActivity: (onActivity) => {
			activity = onActivity;
			return unwatch;
		},
		thresholdBytes: 32 * MB,
		delayMs: 1_000,
	});
	return {
		collector,
		collect,
		unwatch,
		grow: (bytes: number) => {
			heap += bytes;
		},
		setBusy: (value: boolean) => {
			busy = value;
		},
		type: () => activity?.(),
		watching: () => activity !== undefined,
	};
}

describe("IdleCollector", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("collects once idle after the heap grew past the threshold", () => {
		const t = setup();
		t.grow(40 * MB);
		t.collector.schedule();
		expect(t.watching()).toBe(true);
		vi.advanceTimersByTime(999);
		expect(t.collect).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(t.collect).toHaveBeenCalledTimes(1);
		expect(t.unwatch).toHaveBeenCalledTimes(1);
		expect(t.watching()).toBe(false);
	});

	it("skips a collection after a small turn", () => {
		const t = setup();
		t.grow(10 * MB);
		t.collector.schedule();
		vi.advanceTimersByTime(5_000);
		expect(t.collect).not.toHaveBeenCalled();
		// Growth adds up over turns, measured from the last collection.
		t.grow(30 * MB);
		t.collector.schedule();
		vi.advanceTimersByTime(1_000);
		expect(t.collect).toHaveBeenCalledTimes(1);
		// After the collection the heap is at 60 MB: the next turn starts from there.
		t.grow(31 * MB);
		t.collector.schedule();
		vi.advanceTimersByTime(1_000);
		expect(t.collect).toHaveBeenCalledTimes(1);
	});

	it("waits while the user types and is cancelled by a new run", () => {
		const t = setup();
		t.grow(40 * MB);
		t.collector.schedule();
		vi.advanceTimersByTime(800);
		t.type();
		vi.advanceTimersByTime(800);
		expect(t.collect).not.toHaveBeenCalled();
		t.collector.cancel();
		expect(t.watching()).toBe(false);
		vi.advanceTimersByTime(5_000);
		expect(t.collect).not.toHaveBeenCalled();
		t.collector.schedule();
		vi.advanceTimersByTime(1_000);
		expect(t.collect).toHaveBeenCalledTimes(1);
	});

	it("does not collect while busy", () => {
		const t = setup({ busy: true });
		t.grow(40 * MB);
		t.collector.schedule();
		vi.advanceTimersByTime(5_000);
		expect(t.collect).not.toHaveBeenCalled();
		t.setBusy(false);
		t.collector.schedule();
		vi.advanceTimersByTime(1_000);
		expect(t.collect).toHaveBeenCalledTimes(1);
	});

	it("is unavailable on Node", () => {
		expect(runtimeFullCollection()).toBeUndefined();
	});
});
