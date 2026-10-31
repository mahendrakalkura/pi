// What Markdown blocks were rendered to is kept from one render to the next (components/markdown.ts). A theme's functions may
// give something else from one call to the next (a theme that follows a setting); whoever changes what they give invalidates
// the components, and with them what is kept: everything kept belongs to a generation, and invalidating begins a new one.

let generation = 0;

export function renderedMarkdownGeneration(): number {
	return generation;
}

/** Forgets what Markdown blocks were rendered to. */
export function invalidateRenderedMarkdown(): void {
	generation++;
}
