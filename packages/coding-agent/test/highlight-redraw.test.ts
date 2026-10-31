import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createShellRenderers } from "../src/core/tools/renderers/bash.ts";
import { editRenderers } from "../src/core/tools/renderers/edit.ts";
import { renderersMayHighlight } from "../src/core/tools/renderers/highlighting.ts";
import { readRenderers } from "../src/core/tools/renderers/read.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { TranscriptContainer } from "../src/modes/interactive/components/transcript-container.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("grammars loaded on demand redraw only what may use them", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("messages and tool rows say whether they may show a language", () => {
		const languages = new Set(["yaml"]);
		const withYaml = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "```YAML\nkey: value\n```" }]),
		);
		const without = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "plain" }]));
		expect(withYaml.mayHighlight(languages)).toBe(true);
		expect(without.mayHighlight(languages)).toBe(false);
		expect(new UserMessageComponent("see ```yaml").mayHighlight(languages)).toBe(true);
		expect(new UserMessageComponent("nothing").mayHighlight(languages)).toBe(false);
		const transformed = new UserMessageComponent("nothing", undefined, 1, [(markdown) => markdown]);
		expect(transformed.mayHighlight(languages)).toBe(true);

		expect(renderersMayHighlight(createShellRenderers("$"), { command: "cat a.yaml" }, languages)).toBe(false);
		expect(renderersMayHighlight(editRenderers, { path: "a.yaml" }, languages)).toBe(false);
		expect(renderersMayHighlight(readRenderers, { path: "config.yaml" }, languages)).toBe(true);
		expect(renderersMayHighlight(readRenderers, { path: "main.ts" }, languages)).toBe(false);
		expect(renderersMayHighlight({ ...readRenderers }, { file_path: "a.yml" }, languages)).toBe(true);
		const extension: Pick<ToolDefinition, "renderCall"> = { renderCall: () => new Text("x", 0, 0) };
		expect(renderersMayHighlight(extension, {}, languages)).toBe(true);
		expect(renderersMayHighlight(undefined, {}, languages)).toBe(false);

		const extensionTool: ToolDefinition = {
			name: "ext",
			label: "ext",
			description: "ext",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderCall: () => new Text("ext", 0, 0),
		};
		const row = new ToolExecutionComponent("ext", "id", {}, {}, extensionTool, createFakeTui(), "/");
		expect(row.mayHighlight(languages)).toBe(true);
	});

	test("TranscriptContainer invalidates only the entries a filter accepts, once", () => {
		const invalidated: string[] = [];
		const entry = (name: string) => ({
			name,
			render: () => [name],
			invalidate: () => invalidated.push(name),
		});
		const transcript = new TranscriptContainer();
		for (const name of ["a", "b", "c"]) transcript.addChild(entry(name));
		const parent = new Container();
		parent.addChild(transcript);
		transcript.invalidateOnly(
			(child) => (child as { name?: string }).name !== "b",
			() => parent.invalidate(),
		);
		expect(invalidated).toEqual(["a", "c"]);
		parent.invalidate();
		expect(invalidated).toEqual(["a", "c", "a", "b", "c"]);
		expect(parent.render(10)).toEqual(["a", "b", "c"]);
	});
});
