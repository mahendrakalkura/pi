/**
 * Which tool renderers highlight code, and in which language: when the syntax grammars that are loaded on demand arrive,
 * only tool rows that may show code in one of those languages are drawn again (ToolExecutionComponent.mayHighlight()).
 * Renderers that declare nothing (extensions) may highlight anything.
 */

import { getLanguageFromPath } from "../../../modes/interactive/theme/theme.ts";
import type { ToolRenderers } from "../../extensions/types.ts";

const plainRenderFunctions = new WeakSet<object>();
const pathRenderFunctions = new WeakSet<object>();

function renderFunctions(renderers: ToolRenderers): object[] {
	return [renderers.renderCall, renderers.renderResult].filter((render) => render !== undefined);
}

/** Declares renderers that never highlight code. */
export function declarePlainRenderers(renderers: ToolRenderers): void {
	for (const render of renderFunctions(renderers)) plainRenderFunctions.add(render);
}

/** Declares renderers that highlight only the file at `args.path` (or `args.file_path`), in its getLanguageFromPath() language. */
export function declarePathHighlightingRenderers(renderers: ToolRenderers): void {
	for (const render of renderFunctions(renderers)) pathRenderFunctions.add(render);
}

/** Whether `renderers`, drawing a call with `args`, may highlight code in one of `languages` (lowercase names). */
export function renderersMayHighlight(
	renderers: ToolRenderers | undefined,
	args: unknown,
	languages: ReadonlySet<string>,
): boolean {
	if (renderers === undefined) return false;
	let highlightsPath = false;
	for (const render of renderFunctions(renderers)) {
		if (plainRenderFunctions.has(render)) continue;
		if (!pathRenderFunctions.has(render)) return true;
		highlightsPath = true;
	}
	if (!highlightsPath) return false;
	const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	const path = typeof record.path === "string" ? record.path : record.file_path;
	const language = typeof path === "string" ? getLanguageFromPath(path) : undefined;
	return language !== undefined && languages.has(language.toLowerCase());
}
