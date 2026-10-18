import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { readJsonFileUnlocked } from "../src/utils/paths.ts";

describe("readJsonFileUnlocked", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-unlocked-read-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns a complete document, and nothing for a file a writer has truncated or not finished", () => {
		const path = join(dir, "data.json");
		const parse = (content: string) => JSON.parse(content) as unknown;
		writeFileSync(path, JSON.stringify({ a: 1 }, null, 2));
		expect(readJsonFileUnlocked(path, parse)?.value).toEqual({ a: 1 });

		writeFileSync(path, "");
		expect(readJsonFileUnlocked(path, parse)).toBeUndefined();
		writeFileSync(path, '{\n  "a": ');
		expect(readJsonFileUnlocked(path, parse)).toBeUndefined();
		expect(readJsonFileUnlocked(join(dir, "missing.json"), parse)).toBeUndefined();
	});

	it("reads settings without the lock, and under it when the file is not a complete document", () => {
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "project");
		const settingsPath = join(agentDir, "settings.json");
		const lockSync = vi.spyOn(lockfile, "lockSync");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		writeFileSync(settingsPath, JSON.stringify({ theme: "light" }));
		expect(SettingsManager.create(cwd, agentDir).getTheme()).toBe("light");
		expect(lockSync).not.toHaveBeenCalled();

		writeFileSync(settingsPath, '{"theme": "da');
		SettingsManager.create(cwd, agentDir);
		expect(lockSync).toHaveBeenCalledTimes(1);
	});
});
