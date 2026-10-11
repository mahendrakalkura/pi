import { type Component, Container } from "@earendil-works/pi-tui";

/**
 * The transcript. One invalidation of everything can leave out the entries that do not need it (invalidateOnly()):
 * in a long session they are most of the screen, and each one invalidated is rendered again from nothing.
 */
export class TranscriptContainer extends Container {
	private invalidateFilter?: (child: Component) => boolean;

	/** Runs `invalidate`, during which this invalidates only the entries `filter` accepts. */
	invalidateOnly(filter: (child: Component) => boolean, invalidate: () => void): void {
		this.invalidateFilter = filter;
		try {
			invalidate();
		} finally {
			this.invalidateFilter = undefined;
		}
	}

	override invalidate(): void {
		const filter = this.invalidateFilter;
		if (filter === undefined) {
			super.invalidate();
			return;
		}
		for (const child of this.children) {
			if (filter(child)) child.invalidate();
		}
	}
}
