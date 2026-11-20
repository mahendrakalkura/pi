import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("regression #2835: tool allowlists filter extension tools", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tools-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		allowedToolNames?: string[],
		excludeTools?: string[],
		inspectFilter?: (isToolAllowed: (name: string) => boolean, registered: string[]) => void,
	) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						inspectFilter?.(
							(name) => pi.isToolAllowed(name),
							pi.getAllTools().map((tool) => tool.name),
						);
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: allowedToolNames,
			excludeTools,
		});
		await session.bindExtensions({});
		return session;
	}

	it("allows only explicitly listed built-in and extension tools", async () => {
		const session = await createSession(["read", "dynamic_tool"]);

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["dynamic_tool", "read"]);
		expect(session.getActiveToolNames().sort()).toEqual(["dynamic_tool", "read"]);
		expect(session.systemPrompt).toContain("- read: Read file contents");
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).not.toContain("- bash:");
		expect(session.systemPrompt).not.toContain("- edit:");
		session.dispose();
	});

	it.each([
		{ tools: undefined, excludes: undefined, future: true, bash: true, mcp: true },
		{ tools: ["read", "dynamic_tool"], excludes: undefined, future: true, bash: false, mcp: true },
		{ tools: ["read", "dynamic_tool"], excludes: ["dynamic_*", "mcp__*"], future: false, bash: false, mcp: false },
	])("checks the effective name filter before registration ($tools, $excludes)", async (testCase) => {
		const observations: unknown[] = [];
		const session = await createSession(testCase.tools, testCase.excludes, (allows, registered) => {
			observations.push({
				registered: registered.includes("dynamic_tool"),
				future: allows("dynamic_tool"),
				read: allows("read"),
				bash: allows("bash"),
				mcp: allows("mcp__example__future"),
			});
		});
		try {
			expect(observations).toEqual([
				{ registered: false, read: true, future: testCase.future, bash: testCase.bash, mcp: testCase.mcp },
			]);
		} finally {
			session.dispose();
		}
	});

	it("disables all tools when the allowlist is empty", async () => {
		const session = await createSession([]);

		expect(session.getAllTools()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).toContain("<tools>\n(none)\n");
		expect(session.systemPrompt).not.toContain("dynamic_tool");
		session.dispose();
	});
});
