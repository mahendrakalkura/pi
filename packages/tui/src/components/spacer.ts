import { type Component, markStableRender } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	/** The lines rendered, kept while their number is the same: every frame renders every spacer of the transcript. */
	private renderedLines: string[] = [];
	private renderedCount = 0;

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(_width: number): string[] {
		if (this.renderedCount !== this.lines) {
			const result: string[] = [];
			for (let i = 0; i < this.lines; i++) {
				result.push("");
			}
			this.renderedLines = result;
			this.renderedCount = this.lines;
		}
		return this.renderedLines;
	}
}

markStableRender(Spacer);
