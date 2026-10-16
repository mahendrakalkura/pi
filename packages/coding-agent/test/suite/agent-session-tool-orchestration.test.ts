import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * A tool that calls other tools, built only on the extension API: its own name, exposure, loadout
 * hook, and ctx.executeTool(). Codemode and tool search use the same mechanisms.
 */
function orchestratorExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "echo",
		description: "Echo text.",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, { text }) => ({ content: [{ type: "text", text: `echo: ${text}` }], details: {} }),
	});
	pi.registerTool({
		name: "helper",
		label: "helper",
		description: "Only reachable from other tools.",
		parameters: Type.Object({}),
		exposure: "codemode",
		execute: async () => ({ content: [{ type: "text", text: "helped" }], details: {} }),
	});
	pi.registerTool({
		name: "run_tools",
		label: "run_tools",
		description: "Runs tools.",
		parameters: Type.Object({}),
		exposure: "model-only",
		prepareLoadout: (loadout) => ({
			descriptions: {
				run_tools: `Runs tools: ${loadout.callable.map((tool) => tool.name).join(", ")}`,
				echo: "Echo text (also callable from run_tools).",
			},
			hiddenDeclarations: ["echo"],
		}),
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			const helper = await ctx.executeTool("helper", {});
			const echo = await ctx.executeTool("echo", { text: "hi" });
			const self = await ctx.executeTool("run_tools", {});
			const text = [helper, echo, self]
				.map((outcome) => (outcome.result.content[0] as { text: string }).text)
				.join(" | ");
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}

describe("AgentSession tool orchestration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("supports tools that call other tools under any name through the extension API", async () => {
		const toolCalls: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				orchestratorExtension,
				(pi) => {
					pi.on("tool_call", (event) => {
						toolCalls.push(`${event.toolName}:${event.parentToolCallId ?? "top"}`);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		expect(harness.session.getActiveToolNames()).toEqual(["echo", "run_tools"]);
		expect(harness.session.getCallableToolNames()).toEqual(["echo", "helper"]);
		const find = (name: string) => harness.session.agent.state.tools.find((tool) => tool.name === name);
		expect(find("run_tools")?.description).toBe("Runs tools: echo, helper");
		expect(find("echo")?.description).toBe("Echo text (also callable from run_tools).");

		const requestTools: string[][] = [];
		harness.setResponses([
			(context: TranscriptContext) => {
				requestTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage([fauxToolCall("run_tools", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		// echo stays active, but its declaration is left out of requests.
		expect(requestTools[0]).toEqual(["run_tools"]);
		const result = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		if (!result) throw new Error("No tool result");
		expect(result.content).toEqual([{ type: "text", text: "helped | echo: hi | Tool run_tools not found" }]);
		const parent = result.toolCallId;
		expect(toolCalls).toEqual(["run_tools:top", `helper:${parent}`, `echo:${parent}`]);
		expect(result.nestedCalls?.calls.map((call) => [call.id, call.name, call.status])).toEqual([
			[`${parent}/1`, "helper", "ok"],
			[`${parent}/2`, "echo", "ok"],
			[`${parent}/3`, "run_tools", "error"],
		]);
		// The record is persisted with the session.
		const persisted = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(persisted?.type === "message" && persisted.message).toMatchObject({ nestedCalls: result.nestedCalls });
	});

	it("registers codemode and tool_search inactive until they are named", async () => {
		const extensionFactories = [createCodemodeExtension(), createToolSearchExtension()];
		const plain = await createHarness({ extensionFactories });
		harnesses.push(plain);
		expect(plain.session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["codemode", "tool_search"]),
		);
		expect(plain.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);

		// --tools and the defaultTools setting name them explicitly.
		const allowed = await createHarness({ allowedToolNames: ["read", "codemode"], extensionFactories });
		harnesses.push(allowed);
		expect(allowed.session.getActiveToolNames()).toEqual(["read", "codemode"]);
		const initial = await createHarness({ initialActiveToolNames: ["tool_search"], extensionFactories });
		harnesses.push(initial);
		expect(initial.session.getActiveToolNames()).toEqual(["tool_search"]);
	});

	it("leaves results without nested calls unchanged", async () => {
		const harness = await createHarness({ initialActiveToolNames: [], extensionFactories: [orchestratorExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result && "nestedCalls" in result).toBe(false);
	});

	it("runs a browser tool from a fresh print-mode command through the guard", async () => {
		const outcomes: AgentToolCallOutcome[] = [];
		const calls: string[] = [];
		const browserRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "browser_snapshot",
						label: "Browser snapshot",
						description: "Snapshot a Pi-owned page.",
						parameters: Type.Object({ page: Type.String() }),
						exposure: "codemode",
						execute: async (_id, { page }) => {
							browserRuns.push(page);
							return { content: [{ type: "text", text: page }], details: {} };
						},
					});
					pi.registerCommand("accounts", {
						description: "Inspect account page.",
						handler: async (_args, ctx) => {
							expect(ctx.mode).toBe("print");
							expect(ctx.tools.map((tool) => tool.name)).toContain("browser_snapshot");
							outcomes.push(await ctx.executeTool("browser_snapshot", { page: "PIC" }));
						},
					});
					pi.on("tool_call", (event) => {
						calls.push(`${event.toolName}:${event.parentToolCallId}`);
						if (event.toolName === "browser_snapshot" && event.input.page !== "PIC") {
							return { block: true, reason: "Not a Pi-owned page" };
						}
					});
					pi.on("tool_result", (event) => {
						if (event.toolName === "browser_snapshot") return { content: [{ type: "text", text: "guarded" }] };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });

		await harness.session.prompt("/accounts");
		await harness.session.prompt("/accounts");

		expect(browserRuns).toEqual(["PIC", "PIC"]);
		expect(calls).toEqual(["browser_snapshot:command:1", "browser_snapshot:command:2"]);
		expect(outcomes.map((outcome) => outcome.result.content)).toEqual([
			[{ type: "text", text: "guarded" }],
			[{ type: "text", text: "guarded" }],
		]);
		expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(2);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("blocks command-originated browser calls when the guard denies access", async () => {
		const outcomes: AgentToolCallOutcome[] = [];
		const calls: string[] = [];
		const browserRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "browser_snapshot",
						label: "Browser snapshot",
						description: "Snapshot a Pi-owned page.",
						parameters: Type.Object({ page: Type.String() }),
						exposure: "codemode",
						execute: async (_id, { page }) => {
							browserRuns.push(page);
							return { content: [{ type: "text", text: page }], details: {} };
						},
					});
					pi.registerTool({
						name: "browser_controller",
						label: "Browser controller",
						description: "Model-only browser controller.",
						parameters: Type.Object({}),
						exposure: "model-only",
						execute: async () => ({ content: [{ type: "text", text: "unreachable" }], details: {} }),
					});
					pi.registerCommand("accounts", {
						description: "Inspect account page.",
						handler: async (_args, ctx) => {
							expect(ctx.tools.map((tool) => tool.name)).not.toContain("browser_controller");
							outcomes.push(await ctx.executeTool("browser_snapshot", { page: "unowned" }));
							outcomes.push(await ctx.executeTool("browser_snapshot", {}));
							outcomes.push(await ctx.executeTool("browser_controller", {}));
						},
					});
					pi.on("tool_call", (event) => {
						calls.push(event.toolName);
						if (event.toolName === "browser_snapshot") return { block: true, reason: "Not a Pi-owned page" };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });

		await harness.session.prompt("/accounts");

		expect(calls).toEqual(["browser_snapshot"]);
		expect(browserRuns).toEqual([]);
		expect(outcomes.map((outcome) => [outcome.isError, outcome.result.content[0]])).toEqual([
			[true, { type: "text", text: "Not a Pi-owned page" }],
			[true, expect.objectContaining({ text: expect.stringContaining("page") })],
			[true, { type: "text", text: "Tool browser_controller not found" }],
		]);
		expect(harness.session.messages).toEqual([]);
	});
});
