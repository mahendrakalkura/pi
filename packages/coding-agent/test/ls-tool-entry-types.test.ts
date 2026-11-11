import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { readdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { pathExists } from "../src/core/tools/path-utils.ts";

describe("ls tool entry types", () => {
	let dir: string;
	// Custom operations take the path that stats every entry, as the tool did before it used the entries' types.
	const statEveryEntry = () =>
		createLsToolDefinition(dir, { operations: { exists: pathExists, stat, readdir: (path) => readdir(path) } });

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-ls-types-"));
	});

	afterEach(() => {
		if (existsSync(join(dir, "unsearchable"))) chmodSync(join(dir, "unsearchable"), 0o755);
		rmSync(dir, { recursive: true, force: true });
	});

	async function run(tool: ReturnType<typeof createLsToolDefinition>, args: { path?: string; limit?: number }) {
		try {
			const result = await tool.execute("id", args, undefined, undefined, undefined as never);
			return { content: result.content, details: result.details };
		} catch (error) {
			return { error: (error as Error).message };
		}
	}

	it("lists what stat-ing every entry lists", async () => {
		mkdirSync(join(dir, "Folder"));
		mkdirSync(join(dir, ".hidden-dir"));
		writeFileSync(join(dir, "file.txt"), "x");
		writeFileSync(join(dir, ".dotfile"), "x");
		writeFileSync(join(dir, "été.md"), "x");
		writeFileSync(join(dir, "Zeta"), "x");
		writeFileSync(join(dir, "alpha"), "x");
		for (let i = 0; i < 30; i++) writeFileSync(join(dir, `n${i}`), "x");
		symlinkSync(join(dir, "Folder"), join(dir, "link-to-dir"));
		symlinkSync(join(dir, "file.txt"), join(dir, "link-to-file"));
		symlinkSync(join(dir, "missing"), join(dir, "broken-link"));
		symlinkSync(join(dir, "loop-b"), join(dir, "loop-a"));
		symlinkSync(join(dir, "loop-a"), join(dir, "loop-b"));
		if (process.platform !== "win32") execFileSync("mkfifo", [join(dir, "fifo")]);
		// Read but not searched: every stat in it fails, so it lists as empty.
		mkdirSync(join(dir, "unsearchable"));
		writeFileSync(join(dir, "unsearchable", "inside"), "x");
		mkdirSync(join(dir, "unsearchable", "sub"));
		chmodSync(join(dir, "unsearchable"), 0o444);

		for (const args of [{}, { limit: 5 }, { limit: 1 }, { path: "Folder" }, { path: "link-to-dir" }]) {
			expect(await run(createLsToolDefinition(dir), args), JSON.stringify(args)).toStrictEqual(
				await run(statEveryEntry(), args),
			);
		}
		const listing = await run(createLsToolDefinition(dir), {});
		expect(listing.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("link-to-dir/\n") });
		expect(JSON.stringify(listing)).not.toContain("broken-link");

		if (process.platform !== "win32" && process.getuid?.() !== 0) {
			expect(await run(createLsToolDefinition(dir), { path: "unsearchable" })).toStrictEqual({
				content: [{ type: "text", text: "(empty directory)" }],
				details: undefined,
			});
		}
		expect(await run(createLsToolDefinition(dir), { path: "unsearchable" })).toStrictEqual(
			await run(statEveryEntry(), { path: "unsearchable" }),
		);
	});
});
