import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

function provider(name: string) {
	return { baseUrl: "https://provider.test/v1", apiKey: "key", api: "openai-completions", name };
}

describe("ModelConfig.load", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-model-config-"));
		path = join(dir, "models.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads models.json once while it is unchanged, and again when it changes", async () => {
		writeFileSync(path, JSON.stringify({ providers: { one: provider("One") } }));
		const first = await ModelConfig.load(path);
		expect(await ModelConfig.load(path)).toBe(first);
		expect(first.getProviderIds()).toEqual(["one"]);

		writeFileSync(path, JSON.stringify({ providers: { one: provider("One"), two: provider("Two") } }));
		const changed = await ModelConfig.load(path);
		expect(changed).not.toBe(first);
		expect(changed.getProviderIds()).toEqual(["one", "two"]);
	});

	it("keeps a parse error only while the file is unchanged", async () => {
		writeFileSync(path, "{ not json");
		const broken = await ModelConfig.load(path);
		expect(broken.getError()).toContain("Failed to parse models.json");
		expect(await ModelConfig.load(path)).toBe(broken);

		writeFileSync(path, JSON.stringify({ providers: { one: provider("One") } }));
		const fixed = await ModelConfig.load(path);
		expect(fixed.getError()).toBeUndefined();
		expect(fixed.getProviderIds()).toEqual(["one"]);
	});

	it("reads a file that appears after a load found none", async () => {
		expect((await ModelConfig.load(path)).getProviderIds()).toEqual([]);
		writeFileSync(path, JSON.stringify({ providers: { one: provider("One") } }));
		expect((await ModelConfig.load(path)).getProviderIds()).toEqual(["one"]);
	});
});
