/**
 * Minimal TUI implementation with differential rendering
 */

import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import { invalidateRenderedMarkdown } from "./rendered-markdown.ts";
import type { Terminal } from "./terminal.ts";
import {
	parseOscColorResponse,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
	type TerminalColors,
} from "./terminal-colors.ts";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

/**
 * Component interface - all components must implement this
 */
export type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
export type TuiMouseButton = "left" | "middle" | "right" | "none";

/** Normalized cell-based mouse event. Coordinates are zero-based. */
export interface TuiMouseEvent {
	type: TuiMouseEventType;
	button: TuiMouseButton;
	/** Coordinates local to the receiving component. */
	x: number;
	y: number;
	/** Absolute terminal coordinates. */
	screenX: number;
	screenY: number;
	/** Current component bounds. */
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** Logical lines. Negative values scroll up. */
	wheelDelta?: number;
	/** Consecutive click count when type is click. */
	clickCount?: number;
}

export interface TuiMouseEventResult {
	/** Stop propagation and suppress renderer-level fallback behavior. */
	handled?: boolean;
	/** Route subsequent drag/release events to this component. Implies handled. */
	capture?: boolean;
	/** Give keyboard focus to this component. Implies handled. */
	focus?: boolean;
	/**
	 * Explicitly request or suppress a render. Move and release default to false;
	 * press, click, drag, and wheel default to true.
	 */
	render?: boolean;
}

/** Internal target metadata used by containers and alternate-screen dispatch. */
export interface TuiMouseDispatchTarget {
	component: Component;
	originX: number;
	originY: number;
	width: number;
	height: number;
}

/** Result of dispatching to a concrete component. */
export interface TuiMouseDispatchResult extends TuiMouseEventResult {
	handled: true;
	target: TuiMouseDispatchTarget;
	/** Keyboard focus target, which may be a delegating parent container. */
	focusTarget?: Component;
}

/**
 * Dispatch an event to a component and retain the exact target and coordinate
 * transform. Containers use this when forwarding events to nested children.
 */
export function dispatchMouseEvent(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
	const result = component.handleMouse?.(event);
	if (!result) return undefined;
	if ("target" in result) {
		// The component forwarded the event to a child it hosts. Like a delegating container, it routes
		// keys to that child itself, so it keeps keyboard focus. Focusing the child directly would leave
		// focus on a detached component once the host removes it, e.g. a closed settings submenu.
		const forwarded = result as TuiMouseDispatchResult;
		return forwarded.focus && component.handleInput ? { ...forwarded, focusTarget: component } : forwarded;
	}
	if (!result.handled && !result.capture && !result.focus) return undefined;
	return {
		...result,
		handled: true,
		...(result.focus ? { focusTarget: component } : {}),
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

/** Recreate local coordinates for a previously dispatched mouse target. */
export function retargetMouseEvent(event: TuiMouseEvent, target: TuiMouseDispatchTarget): TuiMouseEvent {
	return {
		...event,
		x: event.screenX - target.originX,
		y: event.screenY - target.originY,
		width: target.width,
		height: target.height,
	};
}

export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/** Optional handler for keyboard input when component has focus. */
	handleInput?(data: string): void;

	/** Optional normalized mouse handler. */
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;
type PendingTerminalColorQuery = {
	foreground?: RgbColor;
	background?: RgbColor;
	palette: Array<RgbColor | undefined>;
	/** Targets that already replied, so duplicates do not count twice. */
	replied: Set<string>;
	/**
	 * Receives the result: the promise's resolve until the timeout, then `onLateReply`. Unset once the
	 * query completed (on the DA1 reply or once every color replied); later replies are ignored.
	 */
	deliver: ((colors: TerminalColors) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

const TERMINAL_PALETTE_SIZE = 16;
/** OSC 10 and 11 plus OSC 4 for every palette color. */
const TERMINAL_COLOR_REPLY_COUNT = 2 + TERMINAL_PALETTE_SIZE;
/**
 * Default colors, palette colors 0-15, and a trailing primary device attributes (DA1) request.
 * Every terminal answers DA1 and terminals answer in order, so the DA1 reply marks the end of
 * the color replies, including for terminals that ignore the color queries.
 */
const TERMINAL_COLOR_QUERY = `\x1b]10;?\x07\x1b]11;?\x07${Array.from(
	{ length: TERMINAL_PALETTE_SIZE },
	(_, index) => `\x1b]4;${index};?\x07`,
).join("")}\x1b[c`;
const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = /^\x1b\[\?[\d;]*c$/;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

/** Fake cursor markers - zero-width APC sequences around the text drawn as the cursor. See resolveFakeCursors(). */
export const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
// CURSOR_MARKER + FAKE_CURSOR_START + text + FAKE_CURSOR_END. Truncating the line right after the cursor cell drops the end.
const FOCUSED_FAKE_CURSOR = /(\x1b_pi:c\x07)\x1b_pi:fc\x07(.*?)(?:\x1b_pi:\/fc\x07|$)/s;

/** Wrap text in fake cursor markers. */
export function renderFakeCursor(text: string): string {
	return `${FAKE_CURSOR_START}${text}${FAKE_CURSOR_END}`;
}

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	target: Component | null;
}

/** Last rendered terminal-relative overlay rectangle. */
export interface OverlayBounds {
	row: number;
	col: number;
	width: number;
	height: number;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
	/** Get the most recent rendered bounds for a visible overlay. */
	getBounds(): OverlayBounds | undefined;
}

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
	bounds?: OverlayBounds;
};

type RenderedOverlayLayout = {
	entry: OverlayStackEntry;
	row: number;
	col: number;
	width: number;
	height: number;
};

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

/** render() functions whose component keeps its lines: see markStableRender(). */
const stableRenders = new WeakSet<Component["render"]>();

/**
 * Declares that the components of a class keep their lines: their render() returns the same array again only while
 * their lines are unchanged, and never modifies an array it returned. Containers then take an unchanged array as
 * unchanged lines and a new array as changed lines instead of comparing them line by line, which keeps a frame from
 * costing time in proportion to the whole transcript. (A new array with the same lines is taken as changed: the lines
 * after it are joined again, and what is drawn is the same.) A subclass that overrides render() is not covered: it
 * declares this itself if it keeps its lines. Components that do not declare it render exactly as before; their lines
 * are compared.
 */
export function markStableRender(componentClass: { prototype: Component }): void {
	stableRenders.add(componentClass.prototype.render);
}

/**
 * Whether `component` keeps its lines (markStableRender()). A Container that does not override render() does:
 * renderSharedLines() takes its lines from renderShared().
 */
export function isStableRender(component: Component): boolean {
	return (
		(component instanceof Container && component.render === Container.prototype.render) ||
		stableRenders.has(component.render)
	);
}

/**
 * A component's lines, without the copy Container.render() makes: Container.renderShared() for a Container that does
 * not override render(). The caller must not modify them.
 */
export function renderSharedLines(component: Component, width: number): string[] {
	return component instanceof Container && component.render === Container.prototype.render
		? component.renderShared(width)
		: component.render(width);
}

/**
 * Lines that their owner changes in place, from some line on, instead of making a new array for each change: a reply that
 * streams in grows at its end, and making the lines of all of it again, at each level of components it is in, takes time
 * in proportion to its length on every frame. Each change raises `revision` and records the first line it changed, so a
 * reader that kept the revision it read knows which lines to read again (changedSince()).
 * Only readers that do (renderLiveLines()) are given such lines; the others get arrays that never change (renderShared()).
 */
export interface LiveLines {
	/** The lines. Not to be modified, and changed by their owner: read again after each render. */
	readonly lines: readonly string[];
	readonly revision: number;
	/**
	 * The first line that may differ from what the lines were at `revision` (lines added after that count as changed):
	 * Infinity when nothing changed since, 0 when that revision is not known any more.
	 */
	changedSince(revision: number): number;
}

/** How many changes LiveLineArray remembers the first changed line of. */
const LIVE_LINE_EDITS_KEPT = 32;

/** LiveLines that its owner changes with edit(). */
export class LiveLineArray implements LiveLines {
	readonly lines: string[] = [];
	revision = 0;
	/** The first line changed by each of the last changes, the last one last: change `revision - k` at `starts.length - 1 - k`. */
	private readonly starts: number[] = [];

	changedSince(revision: number): number {
		if (revision === this.revision) return Number.POSITIVE_INFINITY;
		const changes = this.revision - revision;
		if (changes < 0 || changes > this.starts.length) return 0;
		let start = Number.POSITIVE_INFINITY;
		for (let i = this.starts.length - changes; i < this.starts.length; i++) start = Math.min(start, this.starts[i]!);
		return start;
	}

	/** Drops the lines from `start` on, for the owner to add the new ones (push()), and records the change. */
	edit(start: number): void {
		this.lines.length = Math.min(this.lines.length, start);
		this.revision++;
		this.starts.push(start);
		if (this.starts.length > LIVE_LINE_EDITS_KEPT) this.starts.shift();
	}
}

/** The live renderers (renderLiveLines()), by the method that identifies the class: render(), or renderShared() for a Container. */
const liveRenders = new WeakMap<object, (this: Component, width: number) => LiveLines | undefined>();

/**
 * Declares how components render live lines (LiveLines): `renderLive` is called for a component whose render() is `key`, or,
 * for a Container that does not override render(), whose renderShared() is `key`. A subclass that overrides that method is
 * not covered, so it renders as it says it does. `renderLive` may return undefined: the component's lines are then taken as
 * renderSharedLines() takes them.
 */
export function markLiveRender(
	key: Component["render"] | Container["renderShared"],
	renderLive: (this: Component, width: number) => LiveLines | undefined,
): void {
	liveRenders.set(key, renderLive);
}

/**
 * A component's lines as LiveLines, for a reader that reads them again after each render as changedSince() says: for the
 * components that render so (markLiveRender()); undefined for the others (renderSharedLines()).
 */
export function renderLiveLines(component: Component, width: number): LiveLines | undefined {
	const key =
		component instanceof Container && component.render === Container.prototype.render
			? component.renderShared
			: component.render;
	return liveRenders.get(key)?.call(component, width);
}

/** What a list of children rendered to, joined (renderChildren()). */
export interface RenderedChildren {
	readonly width: number;
	readonly children: readonly Component[];
	/** The array each child returned. */
	readonly arrays: readonly string[][];
	readonly heights: readonly number[];
	/** All the children's lines. Shared: not to be modified. */
	readonly lines: string[];
}

/**
 * Renders `children` at `width` and joins their lines, starting from what they rendered to the frame before:
 * `previous` itself when no child's lines changed, otherwise new lines that keep the unchanged leading children's
 * lines. A child's lines are unchanged when it is the same child and either keeps its lines (isStableRender()) and
 * returned the same array, or does not keep its lines and returned the lines joined the frame before. The second check
 * covers any component, including one that modifies its array in place. A child that keeps its lines and returned a new
 * array is taken as changed without comparing its lines: while a reply streams in, that is the message growing, and
 * comparing it line by line (at each level of containers it is in) would take time in proportion to its length every
 * frame.
 */
export function renderChildren(
	children: readonly Component[],
	width: number,
	previous: RenderedChildren | undefined,
): RenderedChildren {
	const count = children.length;
	const before = previous?.width === width ? previous : undefined;
	let index = 0;
	let offset = 0;
	let changedLines: string[] | undefined;
	if (before !== undefined) {
		for (; index < count; index++) {
			const child = children[index]!;
			const lines = renderSharedLines(child, width);
			if (
				index >= before.children.length ||
				before.children[index] !== child ||
				!sameLines(child, lines, before, index, offset)
			) {
				changedLines = lines;
				break;
			}
			offset += lines.length;
		}
		if (index === count && count === before.children.length) return before;
	}
	const arrays: string[][] = new Array(count);
	const heights: number[] = new Array(count);
	for (let i = 0; i < index; i++) {
		arrays[i] = before!.arrays[i]!;
		heights[i] = before!.heights[i]!;
	}
	const first = index;
	for (; index < count; index++) {
		const lines = changedLines ?? renderSharedLines(children[index]!, width);
		changedLines = undefined;
		arrays[index] = lines;
		heights[index] = lines.length;
	}
	// (concat() copies the lines in bulk, which a loop that pushes them one by one takes several times as long to do; in
	// groups of arrays, as a call takes a bounded number of arguments.)
	let joined = before !== undefined && offset > 0 ? before.lines.slice(0, offset) : [];
	for (let i = first; i < count; i += 1024) {
		joined = joined.concat(...arrays.slice(i, Math.min(count, i + 1024)));
	}
	return { width, children: children.slice(), arrays, heights, lines: joined };
}

function sameLines(
	child: Component,
	lines: string[],
	previous: RenderedChildren,
	index: number,
	offset: number,
): boolean {
	if (isStableRender(child)) return lines === previous.arrays[index];
	const height = previous.heights[index]!;
	if (lines.length !== height) return false;
	const joined = previous.lines;
	for (let i = 0; i < height; i++) {
		if (lines[i] !== joined[offset + i]) return false;
	}
	return true;
}

/** What a Container's children rendered to (Container.renderLiveChildren()). */
interface ContainerLines {
	width: number;
	children: Component[];
	/** The lines each child rendered to, and the revision they were at for a child that renders live lines (else -1). */
	arrays: (readonly string[])[];
	revisions: number[];
	heights: number[];
	/** All the children's lines. */
	live: LiveLineArray;
}

/** Whether `lines` are the `count` lines of `joined` from `offset` on. */
function sameLinesAt(lines: readonly string[], joined: readonly string[], offset: number, count: number): boolean {
	if (lines.length !== count) return false;
	for (let i = 0; i < count; i++) {
		if (lines[i] !== joined[offset + i]) return false;
	}
	return true;
}

/** Whether `child` and `lines` are what was recorded at `index`. */
function sameChildAt(rendered: ContainerLines, index: number, child: Component, lines: readonly string[]): boolean {
	return rendered.children[index] === child && rendered.arrays[index] === lines;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];
	private rendered?: ContainerLines;
	/** renderShared()'s copy of the live lines, made again when they change. */
	private sharedLines?: { live: LiveLineArray; revision: number; lines: string[] };

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		this.rendered = undefined;
		this.sharedLines = undefined;
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		// The children as last drawn, at their drawn heights.
		const rendered = this.rendered?.width === event.width ? this.rendered : undefined;
		const children = rendered?.children ?? this.children;
		let childY = 0;
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			const childHeight = rendered ? rendered.heights[i]! : child.render(event.width).length;
			if (event.y >= childY && event.y < childY + childHeight) {
				const result = dispatchMouseEvent(child, {
					...event,
					y: event.y - childY,
					height: childHeight,
				});
				if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
				return result;
			}
			childY += childHeight;
		}
		return undefined;
	}

	/**
	 * The children's lines, joined, as LiveLines: changed in place from the first line that changed. A child's lines are
	 * unchanged when it is the same child and: it renders live lines and they are the same LiveLines at the same revision
	 * (or changed from the line changedSince() says); it keeps its lines (isStableRender()) and returned the same array; or
	 * it returned the lines joined the time before. Only the lines from the first one changed on are joined again: while a
	 * reply streams in at the end of the transcript, those are the last lines of the reply.
	 */
	protected renderLiveChildren(width: number): LiveLineArray {
		const children = this.children;
		const count = children.length;
		let rendered = this.rendered?.width === width ? this.rendered : undefined;
		if (rendered === undefined) {
			rendered = { width, children: [], arrays: [], revisions: [], heights: [], live: new LiveLineArray() };
			this.rendered = rendered;
		}
		const before = rendered;
		const live = before.live;
		const joined = live.lines;
		// The leading children whose lines are what they were: nothing is recorded again for them, so a frame in which only
		// the last message changed allocates and copies nothing in proportion to the transcript.
		let first = 0;
		let offset = 0;
		let changeAt = Number.POSITIVE_INFINITY;
		let firstLines: readonly string[] | undefined;
		let firstRevision = -1;
		for (; first < count; first++) {
			const child = children[first]!;
			const childLive = renderLiveLines(child, width);
			const lines = childLive?.lines ?? renderSharedLines(child, width);
			let changedFrom = 0;
			if (first < before.children.length) {
				const sameChild = before.children[first] === child;
				if (childLive !== undefined) {
					if (sameChild && before.arrays[first] === lines && before.revisions[first]! >= 0) {
						changedFrom = childLive.changedSince(before.revisions[first]!);
					}
				} else if (
					before.revisions[first] === -1 &&
					((sameChild && before.arrays[first] === lines && isStableRender(child)) ||
						sameLinesAt(lines, joined, offset, before.heights[first]!))
				) {
					// (The same lines: in the same array from a component that keeps its lines, or line for line, as from a
					// component that does not keep its lines or one put in place of the one before, such as a new spacer.)
					changedFrom = Number.POSITIVE_INFINITY;
				}
			}
			if (changedFrom !== Number.POSITIVE_INFINITY) {
				changeAt = offset + changedFrom;
				firstLines = lines;
				firstRevision = childLive?.revision ?? -1;
				break;
			}
			if (!sameChildAt(before, first, child, lines)) {
				// (A new child with the same lines: recorded, without changing the lines joined.)
				before.children[first] = child;
				before.arrays[first] = lines;
				before.revisions[first] = -1;
			}
			offset += lines.length;
		}
		if (first === count) {
			if (count === before.children.length) return live;
			changeAt = offset;
		}
		// From the first changed child on: recorded again, in place, and its lines and those after it joined again.
		before.children.length = first;
		before.arrays.length = first;
		before.revisions.length = first;
		before.heights.length = first;
		live.edit(changeAt);
		for (let i = first; i < count; i++) {
			const child = children[i]!;
			let lines: readonly string[];
			let revision: number;
			if (i === first && firstLines !== undefined) {
				lines = firstLines;
				revision = firstRevision;
			} else {
				const childLive = renderLiveLines(child, width);
				lines = childLive?.lines ?? renderSharedLines(child, width);
				revision = childLive?.revision ?? -1;
			}
			before.children.push(child);
			before.arrays.push(lines);
			before.revisions.push(revision);
			before.heights.push(lines.length);
			const from = Math.max(0, changeAt - offset);
			for (let j = from; j < lines.length; j++) joined.push(lines[j]!);
			offset += lines.length;
		}
		return live;
	}

	/**
	 * The children's lines, kept from one call to the next: the same array while no child's lines changed. The caller
	 * must not modify it; render() returns a copy. A subclass that adds to the children's lines overrides this, not
	 * render(), and keeps the same contract: it returns the same array again only when its lines are unchanged.
	 */
	renderShared(width: number): string[] {
		const live = this.renderLiveChildren(width);
		const shared = this.sharedLines;
		if (shared?.live === live && shared.revision === live.revision) return shared.lines;
		const lines = live.lines.slice();
		this.sharedLines = { live, revision: live.revision, lines };
		return lines;
	}

	render(width: number): string[] {
		return this.renderShared(width).slice();
	}
}

markLiveRender(Container.prototype.renderShared, function (this: Component, width: number) {
	return (this as Container)["renderLiveChildren"](width);
});

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
	/** Leave renderer output in place for another TUI taking over the same terminal. */
	preserveScreen?: boolean;
}

export interface TUI extends Component {
	readonly mode: TuiMode;
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	readonly fullRedraws: number;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(options?: TuiStopOptions): void;
	renderNow(force?: boolean): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	queryTerminalColors(options: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors>;
}

export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

export abstract class TuiBase extends Container implements TUI {
	abstract readonly mode: TuiMode;
	public terminal: Terminal;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<TuiInputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private immediateRenderScheduled = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private showHardwareCursor = false;
	private clearOnShrink = false;
	protected fullRedrawCount = 0;
	protected stopped = false;
	/**
	 * Color queries waiting for their DA1 reply, oldest first. Terminals answer in order, so color
	 * replies belong to the oldest one. Queries stay here after a timeout to collect late replies.
	 */
	private pendingTerminalColorQueries: PendingTerminalColorQuery[] = [];
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;
	/** Directory for debug/crash logs. When undefined, debug logging is disabled and crash dumps fall back to the OS temp directory. */
	protected readonly logDirectory: string | undefined;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];
	private renderedOverlayLayouts: RenderedOverlayLayout[] = [];

	get hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super();
		this.terminal = terminal;
		this.logDirectory = logDirectory;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	protected abstract doRender(): void;

	protected resetRenderState(): void {}

	protected beforeTerminalStart(): void {}

	protected afterTerminalStart(): void {}

	protected beforeTerminalStop(_options: TuiStopOptions): void {}

	protected afterTerminalStop(_options: TuiStopOptions): void {}

	/** Mode resets written before the terminal's own resets when the process exits without stop(). */
	protected getExitRestorePrefix(): string {
		return `${this.terminalColorSchemeNotificationsEnabled ? "\x1b[?2031l" : ""}\x1b[?25h`;
	}

	/** Mode resets written after the terminal's own resets when the process exits without stop(). */
	protected getExitRestoreSuffix(): string {
		return "";
	}

	/**
	 * Last-resort restore for exit paths that skip stop(), e.g. a direct process.exit() (#11170).
	 * Hard kills and native aborts run no JavaScript and cannot be covered.
	 */
	private readonly exitRestoreHandler = (): void => {
		if (this.stopped) return;
		try {
			this.terminal.restoreOnExit?.(this.getExitRestorePrefix(), this.getExitRestoreSuffix());
		} catch {
			// Never throw from an exit handler.
		}
	};

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.hideTerminalCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true, empty rows are cleared when content shrinks.
	 * When false (default), empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	getFocusedComponent(): Component | null {
		return this.focusedComponent;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					this.overlayFocusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.overlayFocusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	private isComponentMounted(component: Component): boolean {
		return this.getMountedRoots().some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.hideTerminalCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.hideTerminalCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
			getBounds: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry) || !entry.bounds) return undefined;
				return { ...entry.bounds };
			},
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.hideTerminalCursor();
		this.requestRender();
	}

	/** Hide the cursor while running. After stop(), the shell owns the cursor and it must stay visible. */
	private hideTerminalCursor(): void {
		if (!this.stopped) this.terminal.hideCursor();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if the focused component is a visible overlay */
	protected isOverlayFocused(): boolean {
		return this.overlayStack.some(
			(entry) => entry.component === this.focusedComponent && this.isOverlayVisible(entry),
		);
	}

	/** Keep overlay containers as keyboard focus owners when a nested control is clicked. */
	protected resolveMouseFocusTarget(component: Component): Component {
		for (let index = this.overlayStack.length - 1; index >= 0; index--) {
			const overlay = this.overlayStack[index]!;
			if (this.isOverlayVisible(overlay) && this.containsComponent(overlay.component, component)) {
				return overlay.component;
			}
		}
		return component;
	}

	/** Dispatch to the visually topmost overlay under the pointer. */
	protected dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		for (let index = this.renderedOverlayLayouts.length - 1; index >= 0; index--) {
			const layout = this.renderedOverlayLayouts[index]!;
			if (
				event.screenX < layout.col ||
				event.screenX >= layout.col + layout.width ||
				event.screenY < layout.row ||
				event.screenY >= layout.row + layout.height
			) {
				continue;
			}
			const result = dispatchMouseEvent(layout.entry.component, {
				...event,
				x: event.screenX - layout.col,
				y: event.screenY - layout.row,
				width: layout.width,
				height: layout.height,
			});
			return result
				? {
						hit: true,
						result: result.focus ? { ...result, focusTarget: layout.entry.component } : result,
					}
				: { hit: true };
		}
		return { hit: false };
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	override invalidate(): void {
		// (Also when no Markdown component is mounted to be told: what was rendered before may be taken up by a later one.)
		invalidateRenderedMarkdown();
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate();
	}

	start(): void {
		this.stopped = false;
		process.off("exit", this.exitRestoreHandler);
		process.on("exit", this.exitRestoreHandler);
		this.beforeTerminalStart();
		this.terminal.start(
			(data) => this.handleTerminalInput(data),
			() => this.requestRender(),
		);
		this.afterTerminalStart();
		this.terminal.hideCursor();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: TuiInputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(options: TuiStopOptions = {}): void {
		this.stopped = true;
		process.off("exit", this.exitRestoreHandler);
		this.cancelRenderTimer();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031l");
		}
		this.beforeTerminalStop(options);
		this.terminal.showCursor();
		this.terminal.stop();
		this.afterTerminalStop(options);
	}

	renderNow(force = false): void {
		if (force) this.resetRenderState();
		this.renderRequested = false;
		this.cancelRenderTimer();
		this.lastRenderAt = performance.now();
		this.doRender();
	}

	requestRender(force = false): void {
		if (force) {
			this.resetRenderState();
			this.requestImmediateRender();
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private requestImmediateRender(): void {
		this.cancelRenderTimer();
		this.renderRequested = true;
		if (this.immediateRenderScheduled) return;
		this.immediateRenderScheduled = true;
		process.nextTick(() => {
			this.immediateRenderScheduled = false;
			if (this.stopped || !this.renderRequested) return;
			// A previously queued scheduleRender() can create a timer before this
			// callback runs. User input must preempt that throttled frame.
			this.cancelRenderTimer();
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
		});
	}

	private cancelRenderTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleTerminalInput(data: string): void {
		if (this.consumeTerminalColorResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			// Keyboard input is latency-sensitive. Avoid the throttled timer path,
			// where even setTimeout(0) can take a full 16 ms tick on Windows.
			this.requestImmediateRender();
		}
	}

	private consumeTerminalColorResponse(data: string): boolean {
		const query = this.pendingTerminalColorQueries[0];
		if (!query) {
			return false;
		}
		if (DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data)) {
			this.pendingTerminalColorQueries.shift();
			this.completeTerminalColorQuery(query);
			return true;
		}

		const response = parseOscColorResponse(data);
		if (!response) {
			return false;
		}
		const { target, rgb } = response;
		const key = String(target);
		if (!query.deliver || query.replied.has(key)) {
			return true;
		}
		query.replied.add(key);
		if (target === "foreground") {
			query.foreground = rgb;
		} else if (target === "background") {
			query.background = rgb;
		} else if (target < TERMINAL_PALETTE_SIZE) {
			query.palette[target] = rgb;
		}
		if (query.replied.size === TERMINAL_COLOR_REPLY_COUNT) {
			this.completeTerminalColorQuery(query);
		}
		return true;
	}

	private terminalColorQueryResult(query: PendingTerminalColorQuery): TerminalColors {
		const palette = query.palette.every((color) => color !== undefined) ? (query.palette as RgbColor[]) : undefined;
		return { foreground: query.foreground, background: query.background, palette };
	}

	private completeTerminalColorQuery(query: PendingTerminalColorQuery): void {
		const deliver = query.deliver;
		query.deliver = undefined;
		clearTimeout(query.timer);
		deliver?.(this.terminalColorQueryResult(query));
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) {
			this.renderedOverlayLayouts = [];
			return lines;
		}
		const result = [...lines];

		for (const entry of this.overlayStack) entry.bounds = undefined;

		// Pre-render all visible overlays and calculate positions
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = this.resolveFakeCursors(component.render(width));

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			entry.bounds = { row, col, width, height: overlayLines.length };

			rendered.push({ entry, overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}
		this.renderedOverlayLayouts = rendered.map(({ entry, row, col, w, overlayLines }) => ({
			entry,
			row,
			col,
			width: w,
			height: overlayLines.length,
		}));

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	protected applyLineResets(lines: string[]): string[] {
		const reset = SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	/**
	 * Resolve fake cursor markers to reverse video. When the hardware cursor is shown, a fake cursor
	 * directly after CURSOR_MARKER is dropped because the terminal cursor is drawn there. Fake cursors
	 * of components without focus have no CURSOR_MARKER and stay visible.
	 */
	protected resolveFakeCursors(lines: string[]): string[] {
		return lines.map((line) => {
			if (!line.includes(FAKE_CURSOR_START)) return line;
			const resolved = this.showHardwareCursor ? line.replace(FOCUSED_FAKE_CURSOR, "$1$2") : line;
			return resolved.replaceAll(FAKE_CURSOR_START, "\x1b[7m").replaceAll(FAKE_CURSOR_END, "\x1b[27m");
		});
	}

	/**
	 * Query the terminal's theme colors: the default foreground (OSC 10), the default background
	 * (OSC 11), and ANSI colors 0-15 (OSC 4), followed by a DA1 request that marks the end of the
	 * replies. Resolves when the DA1 reply or all color replies arrive, or when the timeout expires.
	 * Colors the terminal did not report are undefined; the palette is only set when all 16 arrived.
	 * @param timeoutMs Query timeout in milliseconds, for terminals that do not answer DA1 either.
	 * @param onLateReply Receives the replies if the query completes after the timeout, e.g. over slow links.
	 */
	queryTerminalColors({
		timeoutMs,
		onLateReply,
	}: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors> {
		return new Promise((resolve) => {
			const query: PendingTerminalColorQuery = {
				palette: Array.from({ length: TERMINAL_PALETTE_SIZE }, () => undefined),
				replied: new Set(),
				deliver: resolve,
				timer: undefined,
			};
			// Resolve with the replies so far, and keep collecting late replies for `onLateReply`.
			query.timer = setTimeout(() => {
				query.deliver = onLateReply;
				resolve(this.terminalColorQueryResult(query));
			}, timeoutMs);
			this.pendingTerminalColorQueries.push(query);
			this.terminal.write(TERMINAL_COLOR_QUERY);
		});
	}
}
