import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import {
	type AutocompleteItem,
	CombinedAutocompleteProvider,
	createFdNameMatcher,
	isPlainFdQuery,
} from "../src/autocomplete.ts";

// @ completion lists a folder with fd once per completion and filters the listing in-process for each key. These tests
// check that the suggestions are the ones fd gives for each key, and that the listing follows changes to the folder.

const fdPath = (() => {
	const result = spawnSync(process.platform === "win32" ? "where" : "which", ["fd"], { encoding: "utf-8" });
	return result.status === 0 ? (result.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null) : null;
})();

const FD_ARGS = ["--type", "f", "--type", "d", "--follow", "--hidden", "--exclude", ".git"];

/** The paths fd lists under `baseDir` for `pattern` (all of them for none). */
function fdPaths(baseDir: string, pattern?: string): string[] {
	const args = ["--base-directory", baseDir, ...FD_ARGS, ...(pattern === undefined ? [] : ["--", pattern])];
	const result = spawnSync(fdPath!, args, { encoding: "utf-8" });
	assert.strictEqual(result.status, 0, result.stderr);
	return result.stdout.split("\n").filter(Boolean).sort();
}

function writeFiles(baseDir: string, files: string[]): void {
	for (const file of files) {
		const path = join(baseDir, file);
		if (file.endsWith("/")) {
			mkdirSync(path, { recursive: true });
		} else {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "x");
		}
	}
}

/** Fewer than 100 entries in all, so that every fd walk is complete and its results do not depend on walk order. */
const TREE = [
	"README.md",
	"readme.txt",
	"Readme.old.md",
	".env",
	".hidden/config.json",
	".github/workflows/ci.yml",
	"a.b.c",
	"aXbYc",
	"src/index.ts",
	"src/editor.ts",
	"src/Editor.test.ts",
	"src/components/Button.tsx",
	"src/components/editor-panel.tsx",
	"src/deep/deeper/deepest/editor.md",
	"docs/My Notes.md",
	"docs/my folder/notes.txt",
	"docs/中文/说明.md",
	"docs/café.md",
	"docs/Kelvin.txt",
	"docs/ſtrange.txt",
	"docs/STRASSE.txt",
	"docs/über.txt",
	"misc/x-y_z.txt",
	"misc/plus+sign.txt",
	"misc/-dash.txt",
	"misc/empty/",
	"ignored/kept.txt",
	"node_modules/pkg/index.js",
	"build/out.js",
];

interface ProviderInternals {
	resolveScopedFuzzyQuery(query: string): { baseDir: string; query: string; displayBase: string } | null;
	runFdForQuery(
		baseDir: string,
		query: string,
		signal: AbortSignal,
	): Promise<{ baseDirEntries: Array<{ path: string; isDirectory: boolean }>; recursiveEntries: unknown[] }>;
	rankFdResults(
		baseDirEntries: unknown[],
		recursiveEntries: unknown[],
		query: string,
		scopedQuery: { baseDir: string; query: string; displayBase: string } | null,
		options: { isQuotedPrefix: boolean },
	): AutocompleteItem[];
}

/** What the provider suggested for an @ query before the listing: the two fd walks of that key, ranked. */
async function fdSuggestions(provider: CombinedAutocompleteProvider, rawQuery: string, isQuotedPrefix = false) {
	const internals = provider as unknown as ProviderInternals;
	const scoped = internals.resolveScopedFuzzyQuery(rawQuery);
	const baseDir = scoped?.baseDir ?? (provider as unknown as { basePath: string }).basePath;
	const query = scoped?.query ?? rawQuery;
	const results = await internals.runFdForQuery(baseDir, query, new AbortController().signal);
	return internals.rankFdResults(results.baseDirEntries, results.recursiveEntries, query, scoped, { isQuotedPrefix });
}

async function suggest(provider: CombinedAutocompleteProvider, line: string): Promise<AutocompleteItem[]> {
	const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	return result?.items ?? [];
}

/** Wait until the provider's background walks are done (they are not awaited by any request). */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("@ completion from an fd listing", { skip: !fdPath }, () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-fd-index-"));
		spawnSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "node_modules\n/build\n");
		writeFiles(root, TREE);
		symlinkSync("docs", join(root, "linked-docs"));
	});

	afterEach(() => {
		mock.restoreAll();
		rmSync(root, { recursive: true, force: true });
	});

	test("matches names as fd matches its pattern", () => {
		const listing = fdPaths(root).map((path) => ({
			path,
			name: basename(path.endsWith("/") ? path.slice(0, -1) : path),
		}));
		const queries = [
			"",
			"e",
			"E",
			"read",
			"READ",
			"rEaD",
			"readme.",
			".md",
			"a.b",
			"a.b.",
			"..",
			"x-y",
			"_z",
			"k",
			"K",
			"K",
			"s",
			"ſ",
			"ss",
			"strasse",
			"ü",
			"Ü",
			"é",
			"中",
			"说明",
			"my ",
			"y f",
			" ",
			"#",
			"@",
			"~",
			"&",
			"zzz",
		];
		for (const query of queries) {
			assert.ok(isPlainFdQuery(query), query);
			const matches = createFdNameMatcher(query);
			const expected = query === "" ? fdPaths(root) : fdPaths(root, query);
			const actual = listing.filter((entry) => matches(entry)).map((entry) => entry.path);
			assert.deepStrictEqual(actual, expected, JSON.stringify(query));
		}
		for (const query of ["-x", "a+b", "a*", "(a)", "[a]", "a{2}", "^a", "a$", "a|b", "a\\d", "a?", "src/ed"]) {
			assert.ok(!isPlainFdQuery(query), query);
		}
	});

	test("suggests what fd gives for each key while typing, editing and moving between folders", async () => {
		const provider = new CombinedAutocompleteProvider([], root, fdPath);
		const sequences = [
			["", "r", "re", "rea", "read", "readm", "readme", "readme.", "readme.m", "readme.md"],
			["R", "RE", "REA", "READ", "REA", "RE", "R", "", "e", "ed", "edi", "edit", "edito", "editor"],
			["E", "Ed", "Edi", "Edit", "Edito", "Editor"],
			["a", "a.", "a.b", "a.b.", "a.b.c"],
			["k", "ke", "kel", "kelv"],
			["ſ", "ſt", "s", "st", "str"],
			["中", "中文", "说", "说明"],
			["src/", "src/e", "src/ed", "src/edi", "src/e", "src/", "src/c", "src/comp"],
			["docs/", "docs/m", "docs/my", "docs/c", "docs/caf"],
			["-", "-d", "-da", "x", "x-", "x-y", "plus", "plus+", "plus+s"],
			["zz", "zzz", "zzzz", "zz", "z"],
			["linked-docs/", "linked-docs/c", "linked-docs/ca"],
			["src/ed", "src/edit", "sr", "s", "src", "src/", "src/i"],
		];
		for (const [index, sequence] of sequences.entries()) {
			// Each sequence types into its own @ token, so each starts a new completion.
			const before = `${"x ".repeat(index)}see `;
			for (const [keyIndex, query] of sequence.entries()) {
				const actual = await suggest(provider, `${before}@${query}`);
				const expected = await fdSuggestions(provider, query);
				assert.deepStrictEqual(actual, expected, JSON.stringify(query));
				// (After the first key the listing is ready, so the later keys are filtered in-process.)
				if (keyIndex === 0) await settle();
			}
		}
	});

	test("suggests what fd gives for quoted @ paths", async () => {
		const provider = new CombinedAutocompleteProvider([], root, fdPath);
		for (const query of ["", "docs/my ", "docs/my f", "docs/my fo", "docs/my folder/", "docs/my folder/n"]) {
			const actual = await suggest(provider, `see @"${query}`);
			const expected = await fdSuggestions(provider, query, true);
			assert.deepStrictEqual(actual, expected, JSON.stringify(query));
		}
	});

	test("a new @ token sees files added and removed since the last completion", async () => {
		const provider = new CombinedAutocompleteProvider([], root, fdPath);
		const values = async (line: string) => (await suggest(provider, line)).map((item) => item.value);
		assert.deepStrictEqual(await values("see @fresh"), []);
		writeFiles(root, ["src/fresh-file.ts"]);
		// The same token (the completion goes on): the listing may not have the file yet. A new token: it does.
		assert.deepStrictEqual(await values("look at @fresh"), ["@src/fresh-file.ts"]);
		unlinkSync(join(root, "src/fresh-file.ts"));
		assert.deepStrictEqual(await values("look again at @fresh"), []);
	});

	test("a completion that goes on refreshes an old listing in the background", async () => {
		let now = Date.now();
		mock.method(Date, "now", () => now);
		const provider = new CombinedAutocompleteProvider([], root, fdPath);
		const values = async (line: string) => (await suggest(provider, line)).map((item) => item.value);
		assert.deepStrictEqual(await values("see @new"), []);
		await settle();
		writeFiles(root, ["newer.txt"]);
		// Within FD_INDEX_STALE_MS the listing is used as it is.
		now += 1_000;
		assert.deepStrictEqual(await values("see @new"), []);
		// Older: used once more while it is walked again, then the new listing is used.
		now += 5_000;
		assert.deepStrictEqual(await values("see @newe"), []);
		await settle();
		assert.deepStrictEqual(await values("see @newer"), ["@newer.txt"]);
	});

	test("keeps a listing per folder, and a new provider lists its own folder", async () => {
		const other = join(root, "docs");
		const provider = new CombinedAutocompleteProvider([], root, fdPath);
		assert.deepStrictEqual(await suggest(provider, "see @notes"), await fdSuggestions(provider, "notes"));
		assert.deepStrictEqual(await suggest(provider, "see @docs/notes"), await fdSuggestions(provider, "docs/notes"));
		const docsProvider = new CombinedAutocompleteProvider([], other, fdPath);
		const items = await suggest(docsProvider, "see @notes");
		assert.deepStrictEqual(items, await fdSuggestions(docsProvider, "notes"));
		assert.ok(items.some((item) => item.value === `@"my folder/notes.txt"`));
	});

	test("runs fd for each key when the folder cannot be listed, filtering complete results", async () => {
		// An fd that fails for the listing (the walk without a pattern), and works otherwise.
		const wrapper = join(root, "fd-no-listing.sh");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nfor arg in "$@"; do [ "$arg" = "100001" ] && exit 1; done\nexec "${fdPath}" "$@"\n`,
		);
		chmodSync(wrapper, 0o755);
		const provider = new CombinedAutocompleteProvider([], root, wrapper);
		for (const query of ["", "e", "ed", "edi", "edit", "edito", "editor", "edit", "e", "r", "rea", "read"]) {
			const actual = await suggest(provider, `see @${query}`);
			const expected = await fdSuggestions(provider, query);
			assert.deepStrictEqual(actual, expected, JSON.stringify(query));
		}
	});
});
