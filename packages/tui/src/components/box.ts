import {
	type Component,
	dispatchMouseEvent,
	markStableRender,
	type RenderedChildren,
	renderChildren,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui.ts";
import { flattenLines, visibleWidth } from "../utils.ts";

type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	// Cache for rendered output
	private cache?: RenderCache;
	private rendered?: RenderedChildren;
	private readonly emptyLines: string[] = [];

	constructor(paddingX = 0, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	setPaddingX(paddingX: number): void {
		if (this.paddingX === paddingX) return;
		this.paddingX = paddingX;
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cache = undefined;
		this.rendered = undefined;
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const contentWidth = Math.max(1, event.width - this.paddingX * 2);
		const contentY = event.y - this.paddingY;
		const contentX = event.x - this.paddingX;
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		// The children as last drawn, at their drawn heights.
		const rendered = this.rendered?.width === contentWidth ? this.rendered : undefined;
		const children = rendered?.children ?? this.children;
		let childY = 0;
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			const childHeight = rendered ? rendered.heights[i]! : child.render(contentWidth).length;
			if (contentY >= childY && contentY < childY + childHeight) {
				return dispatchMouseEvent(child, {
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height: childHeight,
				});
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return this.emptyLines;
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Render all children. Keep the child lines unpadded: children usually return the same string
		// objects every frame, so the cache check below is a cheap identity comparison per line.
		// Padding here would create new strings that must be compared character by character.
		const rendered = renderChildren(this.children, contentWidth, this.rendered);
		this.rendered = rendered;
		const childLines = rendered.lines;

		if (childLines.length === 0) {
			return this.emptyLines;
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// What was rendered at this width and background: still good for the child lines that are the same.
		const cache =
			this.cache && this.cache.width === width && this.cache.bgSample === bgSample ? this.cache : undefined;
		if (cache?.childLines === childLines) {
			return cache.lines;
		}

		// Apply background and padding
		const result: string[] = [];
		let reused = cache !== undefined && cache.childLines.length === childLines.length;

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(cache ? cache.lines[i]! : this.applyBg("", width));
		}

		// Content
		for (let i = 0; i < childLines.length; i++) {
			const line = childLines[i]!;
			if (cache !== undefined && i < cache.childLines.length && cache.childLines[i] === line) {
				result.push(cache.lines[this.paddingY + i]!);
			} else {
				reused = false;
				result.push(this.applyBg(leftPad + line, width));
			}
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(cache ? cache.lines[cache.lines.length - this.paddingY + i]! : this.applyBg("", width));
		}

		// Every line is what it was: keep the array, so the parent sees this box unchanged.
		if (reused) {
			cache!.childLines = childLines;
			return cache!.lines;
		}

		// Update cache
		flattenLines(result);
		this.cache = { childLines, width, bgSample, lines: result };

		return result;
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);
		// Already padded to width, so apply the background directly instead of measuring the line again.
		return this.bgFn ? this.bgFn(padded) : padded;
	}
}

markStableRender(Box);
