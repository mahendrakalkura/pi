/**
 * A full garbage collection while the user reads an answer, so a long session does not keep the garbage of every turn.
 *
 * Problem: an agent run allocates a lot (every request serializes the whole conversation), and on Bun most of it is
 * still held when the run ends: the collector runs a full collection only under memory pressure or on its timer, which
 * a busy run keeps putting off. Over 75 prompts that kept about 60% more memory (Linux: 290 MB RSS instead of 170 MB).
 *
 * Solution: after a run, once Pi is idle (no run, no compaction, no keystroke for a moment), collect, but only when the
 * heap grew by at least `thresholdBytes` since the last such collection: a full collection costs 5-11 ms of CPU, which
 * is not worth it after a small turn. Any activity restarts the wait; a new run cancels it. Bun only: Node's collector
 * is generational and has no such backlog (and no Bun.gc()).
 */

/** Heap growth since the last idle collection that makes the next one worth it. */
export const IDLE_GC_THRESHOLD_BYTES = 32 * 1024 * 1024;
/** How long Pi must be idle before it collects. */
export const IDLE_GC_DELAY_MS = 500;

export interface IdleCollectorOptions {
	/** Runs a full, synchronous collection. */
	collect: () => void;
	/** Bytes in the JavaScript heap and outside it (strings, buffers) the heap holds. */
	heapBytes: () => number;
	/** Whether Pi is busy (a run or compaction): then it does not collect. */
	isBusy: () => boolean;
	/** Calls `onActivity` on user activity (keystrokes) until the returned function is called. */
	watchActivity?: (onActivity: () => void) => () => void;
	thresholdBytes?: number;
	delayMs?: number;
}

type BunWithGc = { gc(force: boolean): void };

/** The runtime's full collection: Bun.gc(true). Undefined on Node. */
export function runtimeFullCollection(): (() => void) | undefined {
	const bun = (globalThis as { Bun?: Partial<BunWithGc> }).Bun;
	const gc = bun?.gc;
	if (typeof gc !== "function") return undefined;
	return () => gc.call(bun, true);
}

/** heapUsed + external from process.memoryUsage(): cheap on Bun (no heap walk, unlike bun:jsc heapStats()). */
export function processHeapBytes(): number {
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.external;
}

export class IdleCollector {
	private readonly options: IdleCollectorOptions;
	private readonly thresholdBytes: number;
	private readonly delayMs: number;
	/** Heap bytes right after the last idle collection (or at creation). */
	private baselineBytes: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopWatching: (() => void) | undefined;

	constructor(options: IdleCollectorOptions) {
		this.options = options;
		this.thresholdBytes = options.thresholdBytes ?? IDLE_GC_THRESHOLD_BYTES;
		this.delayMs = options.delayMs ?? IDLE_GC_DELAY_MS;
		this.baselineBytes = options.heapBytes();
	}

	/** After a run: collect once Pi has been idle for the delay, if the heap grew enough. */
	schedule(): void {
		this.startTimer();
		this.stopWatching ??= this.options.watchActivity?.(() => {
			if (this.timer) this.startTimer();
		});
	}

	/** A new run started: no collection until the next schedule(). */
	cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.stopWatching?.();
		this.stopWatching = undefined;
	}

	dispose(): void {
		this.cancel();
	}

	private startTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.collectIfWorthIt(), this.delayMs);
		this.timer.unref?.();
	}

	private collectIfWorthIt(): void {
		this.cancel();
		if (this.options.isBusy()) return;
		const heapBytes = this.options.heapBytes();
		// The runtime's own collections lower the floor too.
		this.baselineBytes = Math.min(this.baselineBytes, heapBytes);
		if (heapBytes - this.baselineBytes < this.thresholdBytes) return;
		this.options.collect();
		this.baselineBytes = this.options.heapBytes();
	}
}
