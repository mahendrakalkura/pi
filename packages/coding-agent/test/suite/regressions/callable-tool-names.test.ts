import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

it("copies only effective declared and callable tools without exposing indirect or hidden tools to the model", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-callable-names-"));
	const settingsManager = SettingsManager.create(cwd, cwd);
	const register = (pi: ExtensionAPI) => {
		for (const [name, exposure] of [
			["via_codemode", "codemode"],
			["via_deferred", "deferred"],
			["hidden_fixture", "hidden"],
			["excluded_fixture", "deferred"],
		] as const) {
			pi.registerTool({
				name,
				label: name,
				description: name,
				exposure,
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			});
		}
	};
	const create = async (
		tools: string[],
		inspect?: (pi: ExtensionAPI) => void,
		initialActiveTools = ["read"],
	) => {
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			extensionFactories: [
				(pi) => {
					register(pi);
					pi.on("session_start", () => inspect?.(pi));
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			excludeTools: ["excluded_fixture", "mcp__fixture__excluded"],
			initialActiveTools,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			tools,
		});
		await session.bindExtensions({});
		return session;
	};
	try {
		let inherited: string[] = [];
		const parent = await create(
			[
				"read",
				"via_codemode",
				"via_deferred",
				"hidden_fixture",
				"excluded_fixture",
			],
			(pi) => {
				inherited = [
					...new Set([...pi.getActiveTools(), ...pi.getCallableToolNames()]),
				];
			},
		);
		try {
			expect(inherited.sort()).toEqual([
				"read",
				"via_codemode",
				"via_deferred",
			]);
			const child = await create(inherited);
			try {
				expect(child.getActiveToolNames()).toEqual(["read"]);
				expect(child.getCallableToolNames().sort()).toEqual(inherited);
			} finally {
				child.dispose();
			}
		} finally {
			parent.dispose();
		}
		const declared = "mcp__fixture__preselected";
		const callable = "mcp__fixture__callable";
		const excluded = "mcp__fixture__excluded";
		let fixture: ExtensionAPI | undefined;
		const delayed = await create(
			["read", declared, callable, excluded],
			(pi) => {
				fixture = pi;
			},
			["read", declared, excluded],
		);
		try {
			expect(delayed.getActiveToolNames()).toEqual(["read"]);
			if (!fixture) throw new Error("No fixture extension");
			for (const name of [declared, callable, excluded]) {
				fixture.registerTool({
					name,
					label: name,
					description: name,
					exposure: "deferred",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: undefined }),
				});
			}
			expect(delayed.getActiveToolNames()).toEqual(["read", declared]);
			expect(new Set(delayed.getCallableToolNames())).toEqual(
				new Set(["read", declared, callable]),
			);
			fixture.setActiveTools(["read"]);
			fixture.registerTool({
				name: "unrelated",
				label: "unrelated",
				description: "unrelated",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			});
			expect(delayed.getActiveToolNames()).toEqual(["read"]);
		} finally {
			delayed.dispose();
		}
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
});
