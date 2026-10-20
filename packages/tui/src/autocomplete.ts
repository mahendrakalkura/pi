import { spawn } from "child_process";
import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { fuzzyFilter } from "./fuzzy.ts";
import { autocompleteBoundaryRegex, autocompleteSeparatorRegex } from "./utils.ts";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const tokenStartRegex = new RegExp(`${autocompleteBoundaryRegex.source}$`, "u");
// Opening wrappers that may precede a path in prose, mapped to their closing counterpart.
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

function toDisplayPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) {
		return escapeRegex(normalized);
	}

	const hasTrailingSeparator = normalized.endsWith("/");
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	if (!trimmed) {
		return normalized;
	}

	const separatorPattern = "[\\\\/]";
	const segments = trimmed
		.split("/")
		.filter(Boolean)
		.map((segment) => escapeRegex(segment));

	let pattern = segments.join(separatorPattern);
	if (hasTrailingSeparator) {
		pattern += separatorPattern;
	}
	return pattern;
}

function findLastDelimiter(text: string): number {
	let lastDelimiter = -1;
	let index = 0;
	for (const character of text) {
		index += character.length;
		if (PATH_DELIMITERS.has(character) || autocompleteSeparatorRegex.test(character)) {
			lastDelimiter = index - 1;
		}
	}
	return lastDelimiter;
}

// Strip opening wrappers before a path, e.g. "(~/Dev" -> "~/Dev" or "`src/ma" -> "src/ma".
// Keep a wrapper if the token also contains its closer, e.g. "app/[slug]/pa" or "(group)/pa".
function stripLeadingWrappers(token: string): string {
	let result = token;
	while (result.length > 0) {
		const closer = PATH_WRAPPERS[result[0]!];
		if (!closer || result.includes(closer, 1)) {
			break;
		}
		result = result.slice(1);
	}
	return result;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	let start = index;
	while (start > 0 && PATH_WRAPPERS[text[start - 1]!]) {
		start -= 1;
	}
	return PATH_DELIMITERS.has(text[start - 1] ?? "") || tokenStartRegex.test(text.slice(0, start));
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function buildCompletionValue(
	path: string,
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
	const needsQuotes = options.isQuotedPrefix || autocompleteSeparatorRegex.test(path);
	const prefix = options.isAtPrefix ? "@" : "";

	if (!needsQuotes) {
		return `${prefix}${path}`;
	}

	const openQuote = `${prefix}"`;
	const closeQuote = '"';
	return `${openQuote}${path}${closeQuote}`;
}

interface FdEntry {
	path: string;
	isDirectory: boolean;
}

// Use fd to walk directory tree (fast, respects .gitignore)
async function walkDirectoryWithFd(
	baseDir: string,
	fdPath: string,
	query: string,
	maxResults: number,
	signal: AbortSignal,
	maxDepth?: number,
): Promise<FdEntry[]> {
	return (await runFdWalk(baseDir, fdPath, query, maxResults, signal, maxDepth))?.entries ?? [];
}

function fdWalkArgs(baseDir: string, query: string, maxResults: number, maxDepth?: number): string[] {
	const args = [
		"--base-directory",
		baseDir,
		"--max-results",
		String(maxResults),
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		"--exclude",
		".git",
		"--exclude",
		".git/*",
		"--exclude",
		".git/**",
	];

	if (maxDepth !== undefined) {
		args.push("--max-depth", String(maxDepth));
	}

	if (toDisplayPath(query).includes("/")) {
		args.push("--full-path");
	}

	if (query) {
		args.push(buildFdPathQuery(query));
	}
	return args;
}

/** The entry for one line of fd's output, or undefined for a path inside .git. */
function parseFdLine(line: string): FdEntry | undefined {
	const displayLine = toDisplayPath(line);
	const hasTrailingSeparator = displayLine.endsWith("/");
	const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
	if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) {
		return undefined;
	}
	return { path: displayLine, isDirectory: hasTrailingSeparator };
}

/**
 * Run fd and hand each chunk of its output to `onOutput`; resolves true when fd exited with 0, false when it failed or
 * was aborted.
 */
function runFd(
	fdPath: string,
	args: string[],
	signal: AbortSignal | undefined,
	onOutput: (chunk: string) => void,
): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(false);
			return;
		}

		const child = spawn(fdPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let resolved = false;

		const finish = (ok: boolean) => {
			if (resolved) return;
			resolved = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(ok);
		};

		const onAbort = () => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", onOutput);
		child.on("error", () => {
			finish(false);
		});
		child.on("close", (code) => {
			finish(!signal?.aborted && code === 0);
		});
	});
}

/** One fd walk: its entries and the number of lines fd printed, or undefined when fd failed or was aborted. */
async function runFdWalk(
	baseDir: string,
	fdPath: string,
	query: string,
	maxResults: number,
	signal: AbortSignal | undefined,
	maxDepth?: number,
): Promise<{ entries: FdEntry[]; lineCount: number } | undefined> {
	let stdout = "";
	const ok = await runFd(fdPath, fdWalkArgs(baseDir, query, maxResults, maxDepth), signal, (chunk) => {
		stdout += chunk;
	});
	if (!ok) return undefined;
	if (!stdout) return { entries: [], lineCount: 0 };

	const lines = stdout.trim().split("\n").filter(Boolean);
	const results: FdEntry[] = [];
	for (const line of lines) {
		const entry = parseFdLine(line);
		if (entry) results.push(entry);
	}
	return { entries: results, lineCount: lines.length };
}

/**
 * The walk of a whole folder (no pattern, no depth limit) for FdFolderIndex, parsed as fd prints it so that a large
 * listing does not hold up the UI in one piece; undefined when fd failed or the folder has more than `maxEntries`.
 */
async function runFdListing(
	baseDir: string,
	fdPath: string,
	maxEntries: number,
	signal: AbortSignal,
): Promise<IndexedFdEntry[] | undefined> {
	const entries: IndexedFdEntry[] = [];
	let lineCount = 0;
	let partial = "";
	const ok = await runFd(fdPath, fdWalkArgs(baseDir, "", maxEntries + 1), signal, (chunk) => {
		const lines = (partial + chunk).split("\n");
		partial = lines.pop()!;
		for (const line of lines) {
			if (!line) continue;
			lineCount++;
			const entry = parseFdLine(line);
			if (entry) entries.push(indexFdEntry(entry));
		}
	});
	if (partial) {
		lineCount++;
		const entry = parseFdLine(partial);
		if (entry) entries.push(indexFdEntry(entry));
	}
	return ok && lineCount <= maxEntries ? entries : undefined;
}

/** An fd entry with what the in-process filter needs to match it as fd would. */
interface IndexedFdEntry extends FdEntry {
	/** The file name, which is what fd matches its pattern against (without `--full-path`). */
	name: string;
	/** Whether the entry is directly in the walked folder, i.e. what `--max-depth 1` lists. */
	topLevel: boolean;
}

function indexFdEntry(entry: FdEntry): IndexedFdEntry {
	const path = entry.isDirectory ? entry.path.slice(0, -1) : entry.path;
	const slash = path.lastIndexOf("/");
	const name = path.slice(slash + 1);
	return {
		path: entry.path,
		isDirectory: entry.isDirectory,
		name,
		topLevel: slash === -1,
	};
}

/**
 * Every entry an fd walk of one folder lists whose name matches `query`, in fd's output order. The list is complete
 * (fd was not cut off by `--max-results`), so it holds every match of any plain query that extends `query`.
 */
interface FdMatchList {
	query: string;
	entries: IndexedFdEntry[];
	/** The build of the folder's listing this list comes from (see FdFolderIndex). */
	generation: number;
	/** When the walk it comes from started (Date.now()). */
	walkedAt: number;
	/** Whether it comes from the folder's listing (else from fd's complete result for one key). */
	fromListing: boolean;
}

/**
 * Whether fd's pattern for `query` is plain text the in-process filter matches exactly as fd does: no regex syntax but
 * `.` (any character), no leading `-` (fd would read it as an option), no path separator (`--full-path`), and no
 * surrogate code units (the pattern goes to fd as UTF-8).
 */
export function isPlainFdQuery(query: string): boolean {
	return !query.startsWith("-") && !/[\\/+*?()|[\]{}^$\x00-\x1f\x7f\uD800-\uDFFF]/.test(query);
}

/**
 * A test of an entry's name against a plain query (isPlainFdQuery()), with fd's semantics: the pattern is a regex
 * searched in the file name, `.` matches any character (fd sets dot_matches_new_line), and the search ignores case
 * (Unicode simple case folding) unless the pattern has an uppercase character (fd's smart case).
 */
export function createFdNameMatcher(query: string): (entry: { name: string }) => boolean {
	if (query === "") return () => true;
	const regex = new RegExp(query, /\p{Uppercase}/u.test(query) ? "su" : "isu");
	return (entry) => regex.test(entry.name);
}

/** The base-folder (`--max-depth 1`) and recursive results two fd walks capped at `maxResults` give for a complete list. */
function selectFdResults(
	matches: IndexedFdEntry[],
	maxResults: number,
): { baseDirEntries: FdEntry[]; recursiveEntries: FdEntry[] } {
	const baseDirEntries: FdEntry[] = [];
	const recursiveEntries: FdEntry[] = [];
	for (const entry of matches) {
		if (recursiveEntries.length < maxResults) recursiveEntries.push(entry);
		if (entry.topLevel && baseDirEntries.length < maxResults) baseDirEntries.push(entry);
		if (recursiveEntries.length >= maxResults && baseDirEntries.length >= maxResults) break;
	}
	return { baseDirEntries, recursiveEntries };
}

/** The two fd walks of one @ query: direct children and recursive, and how many lines the recursive one printed. */
interface FdQueryResults {
	baseDirEntries: FdEntry[];
	recursiveEntries: FdEntry[];
	recursiveLineCount?: number;
}

/** fd's result cap for each @ completion walk. */
const FD_MAX_RESULTS = 100;
/** A folder with more entries than this is not listed in memory; each key runs fd instead. */
const FD_INDEX_MAX_ENTRIES = 100_000;
/** Within one completion, a listing older than this is refreshed in the background while it is still used. */
const FD_INDEX_STALE_MS = 3_000;
/** After a folder turned out too large to list (or fd failed on it), how long to run fd per key before trying again. */
const FD_INDEX_RETRY_MS = 600_000;
/** How many folders' listings a provider keeps. */
const FD_INDEX_MAX_FOLDERS = 8;

/**
 * The fd listing of one folder, for @ completion without an fd process per keystroke.
 *
 * Each completion (the @ token being typed) starts a fresh walk of the folder without a pattern; until it is done, keys
 * run fd as before. Every later key of that completion filters the listing in-process the way fd filters its walk: the
 * same walk options (.gitignore, hidden files, links, .git excluded), the same name matching (createFdNameMatcher()),
 * and the same 100-result caps (selectFdResults()). A query that extends the previous one filters the previous
 * matches. When fd's results for a key are complete (under the cap), they are the same set either way, and so are the
 * suggestions; when there are more matches than the cap, fd keeps the first 100 it happens to find, which differs from
 * run to run. A listing older than FD_INDEX_STALE_MS is walked again in the background, and used until then.
 *
 * A folder with more than FD_INDEX_MAX_ENTRIES entries is not listed: each key runs fd as before, and a complete
 * result (under the cap) is filtered in-process for the keys that extend its query.
 */
class FdFolderIndex {
	private readonly fdPath: string;
	private readonly baseDir: string;
	/** The newest build started; a list or build is used only by a completion that started at or before it. */
	private generation = 0;
	/** The oldest build the current completion may use. */
	private sessionGeneration = 0;
	private listing: FdMatchList | undefined;
	private narrowed: FdMatchList | undefined;
	private building:
		| { generation: number; promise: Promise<FdMatchList | undefined>; abort: AbortController }
		| undefined;
	private unusableUntil = 0;

	constructor(fdPath: string, baseDir: string) {
		this.fdPath = fdPath;
		this.baseDir = baseDir;
	}

	/** A new completion: walk the folder again (or, if it cannot be listed, forget the previous completion's results). */
	startSession(): void {
		if (Date.now() < this.unusableUntil) {
			this.sessionGeneration = ++this.generation;
			return;
		}
		this.sessionGeneration = this.build();
	}

	/** Stop the walk that is running, if any (a newer completion does not use it); its fd process is killed. */
	cancelListing(): void {
		this.building?.abort.abort();
		this.building = undefined;
	}

	/** A complete list whose query `query` extends, from this completion's walk, if one is ready. */
	readyListFor(query: string): FdMatchList | undefined {
		const now = Date.now();
		const narrowed = this.narrowed;
		if (
			narrowed &&
			narrowed.generation >= this.sessionGeneration &&
			query.startsWith(narrowed.query) &&
			(narrowed.fromListing
				? narrowed.generation === this.listing?.generation
				: now - narrowed.walkedAt <= FD_INDEX_STALE_MS)
		) {
			if (narrowed.fromListing) this.refreshIfStale(narrowed, now);
			return narrowed;
		}
		if (this.listing && this.listing.generation >= this.sessionGeneration) {
			this.refreshIfStale(this.listing, now);
			return this.listing;
		}
		return undefined;
	}

	/** This completion's walk while it runs (undefined when it is done, or when the folder cannot be listed). */
	pendingListing(): Promise<FdMatchList | undefined> | undefined {
		return this.building && this.building.generation >= this.sessionGeneration ? this.building.promise : undefined;
	}

	/** Keep the matches of `query` filtered from `list`, for the next key. */
	setNarrowed(list: FdMatchList): void {
		this.narrowed = list;
	}

	/** Keep fd's complete result for `query` (a folder that is not listed), for the keys that extend it. */
	setCompleteResult(query: string, entries: FdEntry[], walkedAt: number): void {
		this.narrowed = {
			query,
			entries: entries.map(indexFdEntry),
			generation: this.sessionGeneration,
			walkedAt,
			fromListing: false,
		};
	}

	private refreshIfStale(list: FdMatchList, now: number): void {
		if (now - list.walkedAt > FD_INDEX_STALE_MS && !this.building && now >= this.unusableUntil) {
			this.build();
		}
	}

	private build(): number {
		// (A walk still running for an earlier completion would only be thrown away.)
		this.cancelListing();
		const generation = ++this.generation;
		const walkedAt = Date.now();
		const abort = new AbortController();
		const promise = runFdListing(this.baseDir, this.fdPath, FD_INDEX_MAX_ENTRIES, abort.signal)
			.catch(() => undefined)
			.then((entries): FdMatchList | undefined => {
				if (this.building?.generation === generation) this.building = undefined;
				if (abort.signal.aborted) return undefined;
				if (!entries) {
					this.unusableUntil = Date.now() + FD_INDEX_RETRY_MS;
					return undefined;
				}
				const list: FdMatchList = { query: "", entries, generation, walkedAt, fromListing: true };
				if (!this.listing || this.listing.generation < generation) this.listing = list;
				return list;
			});
		this.building = { generation, promise, abort };
		return generation;
	}
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	// Function to get argument completions for this command
	// Returns null if no argument completion is available
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string; // What we're matching against (e.g., "/" or "src/")
}

export interface AutocompleteProvider {
	/** Characters that should naturally trigger this provider at token boundaries. */
	triggerCharacters?: string[];

	// Get autocomplete suggestions for current text/cursor position
	// Returns null if no suggestions available
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;

	// Apply the selected item
	// Returns the new text and cursor position
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};

	// Check if file completion should trigger for explicit Tab completion
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

// Combined provider that handles both slash commands and file paths
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private fdPath: string | null;
	/** fd listings by walked folder (absolute path), for @ completion; least recently used first. */
	private fdIndexes = new Map<string, FdFolderIndex>();
	/** The folder and @ token of the last @ completion request (a different one starts a new completion). */
	private fdSessionKey: string | undefined;
	private fdSessionIndex: FdFolderIndex | undefined;

	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string, fdPath: string | null = null) {
		this.commands = commands;
		this.basePath = basePath;
		this.fdPath = fdPath;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const atPrefix = this.extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			const suggestions = await this.getFuzzyFileSuggestions(rawPrefix, {
				isQuotedPrefix,
				signal: options.signal,
				// The token is identified by its line and the text before it: typing in it keeps the same completion.
				tokenKey: `${cursorLine}\0${textBeforeCursor.slice(0, textBeforeCursor.length - atPrefix.length)}`,
			});
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
			};
		}

		const commandText = textBeforeCursor.trimStart();
		if (!options.force && commandText.startsWith("/")) {
			const spaceIndex = commandText.indexOf(" ");

			if (spaceIndex === -1) {
				const prefix = commandText.slice(1);
				const commandItems = this.commands.map((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
					const desc = cmd.description ?? "";
					const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
					return {
						name,
						label: name,
						description: fullDesc || undefined,
					};
				});

				const bareNameMatches = fuzzyFilter(commandItems, prefix, (item) =>
					item.name.startsWith("skill:") ? item.name.slice("skill:".length) : item.name,
				);
				const bareNameMatchSet = new Set(bareNameMatches);
				const fullNameOnlyMatches = fuzzyFilter(
					commandItems.filter((item) => item.name.startsWith("skill:") && !bareNameMatchSet.has(item)),
					prefix,
					(item) => item.name,
				);
				const filtered = [...bareNameMatches, ...fullNameOnlyMatches].map((item) => ({
					value: item.name,
					label: item.label,
					...(item.description && { description: item.description }),
				}));

				if (filtered.length === 0) return null;

				return {
					items: filtered,
					prefix: commandText,
				};
			}

			const commandName = commandText.slice(1, spaceIndex);
			const argumentText = commandText.slice(spaceIndex + 1);

			const command = this.commands.find((cmd) => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				return name === commandName;
			});
			if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
				return null;
			}

			const argumentSuggestions = await command.getArgumentCompletions(argumentText);
			if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
				return null;
			}

			return {
				items: argumentSuggestions,
				prefix: argumentText,
			};
		}

		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		if (pathMatch === null) {
			return null;
		}

		const suggestions = this.getFileSuggestions(pathMatch);
		if (suggestions.length === 0) return null;

		return {
			items: suggestions,
			prefix: pathMatch,
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
		const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
		const hasTrailingQuoteInItem = item.value.endsWith('"');
		const adjustedAfterCursor =
			isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;

		// Check if we're completing a slash command (prefix starts with "/" but NOT a file path)
		// Slash commands are at the start of the line and don't contain path separators after the first /
		const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
		if (isSlashCommand) {
			// This is a command name completion
			const newLine = `${beforePrefix}/${item.value} ${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
			};
		}

		// Check if we're completing a file attachment (prefix starts with "@")
		if (prefix.startsWith("@")) {
			// This is a file attachment completion
			// Don't add space after directories so user can continue autocompleting
			const isDirectory = item.label.endsWith("/");
			const suffix = isDirectory ? "" : " ";
			const newLine = `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset + suffix.length,
			};
		}

		// Check if we're in a slash command context (beforePrefix contains "/command ")
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// This is likely a command argument completion
			const newLine = beforePrefix + item.value + adjustedAfterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const isDirectory = item.label.endsWith("/");
			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset,
			};
		}

		// For file paths, complete the path
		const newLine = beforePrefix + item.value + adjustedAfterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		const isDirectory = item.label.endsWith("/");
		const hasTrailingQuote = item.value.endsWith('"');
		const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + cursorOffset,
		};
	}

	// Extract @ prefix for fuzzy file suggestions
	private extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const token = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		if (token.startsWith("@")) {
			return token;
		}

		return null;
	}

	// Extract a path-like prefix from the text before cursor
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}

		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		// Only return empty string if the text looks like it's starting a path context
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// Return an empty prefix after whitespace or CJK punctuation, but not for empty text.
		// Empty text should not trigger file suggestions - that's for forced Tab completion
		if (pathPrefix === "" && text !== "" && tokenStartRegex.test(text)) {
			return pathPrefix;
		}

		return null;
	}

	// Expand home directory (~/) to actual home path
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// Preserve trailing slash if original path had one
			return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	private resolveScopedFuzzyQuery(rawQuery: string): { baseDir: string; query: string; displayBase: string } | null {
		const normalizedQuery = toDisplayPath(rawQuery);
		const slashIndex = normalizedQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = normalizedQuery.slice(0, slashIndex + 1);
		const query = normalizedQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = join(this.basePath, displayBase);
		}

		try {
			if (!statSync(baseDir).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	private scopedPathForDisplay(displayBase: string, relativePath: string): string {
		const normalizedRelativePath = toDisplayPath(relativePath);
		if (displayBase === "/") {
			return `/${normalizedRelativePath}`;
		}
		return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
	}

	// Get file/directory suggestions for a given path prefix
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir: string;
			let searchPrefix: string;
			const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
			let expandedPrefix = rawPrefix;

			// Handle home directory expansion
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			const isRootPrefix =
				rawPrefix === "" ||
				rawPrefix === "./" ||
				rawPrefix === "../" ||
				rawPrefix === "~" ||
				rawPrefix === "~/" ||
				rawPrefix === "/" ||
				(isAtPrefix && rawPrefix === "");

			if (isRootPrefix) {
				// Complete from specified position
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (rawPrefix.endsWith("/")) {
				// If prefix ends with /, show contents of that directory
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// Split into directory and file prefix
				const dir = dirname(expandedPrefix);
				const file = basename(expandedPrefix);
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = dir;
				} else {
					searchDir = join(this.basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = readdirSync(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				// Check if entry is a directory (or a symlink pointing to a directory)
				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = join(searchDir, entry.name);
						isDirectory = statSync(fullPath).isDirectory();
					} catch {
						// Broken symlink or permission error - treat as file
					}
				}

				let relativePath: string;
				const name = entry.name;
				const displayPrefix = rawPrefix;

				if (displayPrefix.endsWith("/")) {
					// If prefix ends with /, append entry to the prefix
					relativePath = displayPrefix + name;
				} else if (displayPrefix.includes("/") || displayPrefix.includes("\\")) {
					// Preserve ~/ format for home directory paths
					if (displayPrefix.startsWith("~/")) {
						const homeRelativeDir = displayPrefix.slice(2); // Remove ~/
						const dir = dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : join(dir, name)}`;
					} else if (displayPrefix.startsWith("/")) {
						// Absolute path - construct properly
						const dir = dirname(displayPrefix);
						if (dir === "/") {
							relativePath = `/${name}`;
						} else {
							relativePath = `${dir}/${name}`;
						}
					} else {
						relativePath = join(dirname(displayPrefix), name);
						// path.join normalizes away ./ prefix, preserve it
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							relativePath = `./${relativePath}`;
						}
					}
				} else {
					// For standalone entries, preserve ~/ if original prefix was ~/
					if (displayPrefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				relativePath = toDisplayPath(relativePath);
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, {
					isDirectory,
					isAtPrefix,
					isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			// Sort directories first, then alphabetically
			suggestions.sort((a, b) => {
				const aIsDir = a.label.endsWith("/");
				const bIsDir = b.label.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch (_e) {
			// Directory doesn't exist or not accessible
			return [];
		}
	}

	// Score an entry against the query (higher = better match)
	// isDirectory adds bonus to prioritize folders
	private scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
		const fileName = basename(filePath);
		const lowerFileName = fileName.toLowerCase();
		const lowerQuery = query.toLowerCase();

		let score = 0;

		// Exact filename match (highest)
		if (lowerFileName === lowerQuery) score = 100;
		// Filename starts with query
		else if (lowerFileName.startsWith(lowerQuery)) score = 80;
		// Substring match in filename
		else if (lowerFileName.includes(lowerQuery)) score = 50;
		// Substring match in full path
		else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

		// Directories get a bonus to appear first
		if (isDirectory && score > 0) score += 10;

		return score;
	}

	private async getBaseDirSuggestions(
		baseDir: string,
		query: string,
		signal: AbortSignal,
	): Promise<Array<{ path: string; isDirectory: boolean }>> {
		if (!this.fdPath || signal.aborted) {
			return [];
		}

		return await walkDirectoryWithFd(baseDir, this.fdPath, query, 100, signal, 1);
	}

	// Fuzzy file search using fd (fast, respects .gitignore)
	private async getFuzzyFileSuggestions(
		query: string,
		options: { isQuotedPrefix: boolean; signal: AbortSignal; tokenKey: string },
	): Promise<AutocompleteItem[]> {
		if (!this.fdPath || options.signal.aborted) {
			return [];
		}

		try {
			const scopedQuery = this.resolveScopedFuzzyQuery(query);
			const fdBaseDir = scopedQuery?.baseDir ?? this.basePath;
			const fdQuery = scopedQuery?.query ?? query;
			const results = isPlainFdQuery(fdQuery)
				? await this.getIndexedFdResults(fdBaseDir, fdQuery, options.tokenKey, options.signal)
				: await this.runFdForQuery(fdBaseDir, fdQuery, options.signal);
			if (options.signal.aborted) {
				return [];
			}
			return this.rankFdResults(results.baseDirEntries, results.recursiveEntries, fdQuery, scopedQuery, options);
		} catch {
			return [];
		}
	}

	/** The two fd walks of one @ query (direct children, and recursive), at once. */
	private async runFdForQuery(fdBaseDir: string, fdQuery: string, signal: AbortSignal): Promise<FdQueryResults> {
		// (The two fd runs at once: each is a process start, ~20 ms on Windows, and they do not depend on each other.)
		const [baseDirEntries, recursive] = await Promise.all([
			this.getBaseDirSuggestions(fdBaseDir, fdQuery, signal),
			this.fdPath ? runFdWalk(fdBaseDir, this.fdPath, fdQuery, FD_MAX_RESULTS, signal) : undefined,
		]);
		return { baseDirEntries, recursiveEntries: recursive?.entries ?? [], recursiveLineCount: recursive?.lineCount };
	}

	/**
	 * fd's results for a plain query, from the folder's in-memory listing (FdFolderIndex) when it has one, else from fd,
	 * keeping a complete result for the keys that extend the query.
	 */
	private async getIndexedFdResults(
		fdBaseDir: string,
		fdQuery: string,
		tokenKey: string,
		signal: AbortSignal,
	): Promise<{ baseDirEntries: FdEntry[]; recursiveEntries: FdEntry[] }> {
		let index = this.fdIndexes.get(fdBaseDir);
		if (index) {
			this.fdIndexes.delete(fdBaseDir);
		} else {
			index = new FdFolderIndex(this.fdPath!, fdBaseDir);
			if (this.fdIndexes.size >= FD_INDEX_MAX_FOLDERS) {
				const oldest = this.fdIndexes.keys().next().value!;
				this.fdIndexes.get(oldest)?.cancelListing();
				this.fdIndexes.delete(oldest);
			}
		}
		this.fdIndexes.set(fdBaseDir, index);

		const sessionKey = `${fdBaseDir}\0${tokenKey}`;
		if (sessionKey !== this.fdSessionKey) {
			// The previous completion is over: a walk of another folder still running for it is not needed.
			if (this.fdSessionIndex !== index) this.fdSessionIndex?.cancelListing();
			this.fdSessionKey = sessionKey;
			this.fdSessionIndex = index;
			index.startSession();
		}

		const ready = index.readyListFor(fdQuery);
		if (ready) {
			return this.filterFdList(index, ready, fdQuery);
		}

		// No listing yet: run fd for this key as before, and use the listing instead if it is ready first (the first
		// key of a completion is then no slower than one fd run, on a folder of any size).
		const fdAbort = new AbortController();
		const abortFd = () => fdAbort.abort();
		signal.addEventListener("abort", abortFd, { once: true });
		try {
			const walkedAt = Date.now();
			type Outcome = { list: FdMatchList } | { results: FdQueryResults };
			const viaFd: Promise<Outcome> = this.runFdForQuery(fdBaseDir, fdQuery, fdAbort.signal).then((results) => ({
				results,
			}));
			const pending = index.pendingListing();
			const viaListing = pending?.then((list): Outcome | Promise<Outcome> => (list ? { list } : viaFd));
			const first = await (viaListing ? Promise.race([viaListing, viaFd]) : viaFd);
			if (signal.aborted) {
				return { baseDirEntries: [], recursiveEntries: [] };
			}
			if ("list" in first) {
				fdAbort.abort();
				return this.filterFdList(index, first.list, fdQuery);
			}
			const { results } = first;
			if (results.recursiveLineCount !== undefined && results.recursiveLineCount < FD_MAX_RESULTS) {
				index.setCompleteResult(fdQuery, results.recursiveEntries, walkedAt);
			}
			return results;
		} finally {
			signal.removeEventListener("abort", abortFd);
		}
	}

	/** fd's results for `fdQuery` from a complete list whose query it extends; keeps the matches for the next key. */
	private filterFdList(
		index: FdFolderIndex,
		list: FdMatchList,
		fdQuery: string,
	): { baseDirEntries: FdEntry[]; recursiveEntries: FdEntry[] } {
		const matches = list.query === fdQuery ? list.entries : list.entries.filter(createFdNameMatcher(fdQuery));
		index.setNarrowed({ ...list, query: fdQuery, entries: matches });
		return selectFdResults(matches, FD_MAX_RESULTS);
	}

	/** Score, order and format fd's entries for one @ query (the top 20). */
	private rankFdResults(
		baseDirEntries: FdEntry[],
		recursiveEntries: FdEntry[],
		fdQuery: string,
		scopedQuery: { baseDir: string; query: string; displayBase: string } | null,
		options: { isQuotedPrefix: boolean },
	): AutocompleteItem[] {
		const seenPaths = new Set(baseDirEntries.map((entry) => entry.path));
		const entries = [
			...baseDirEntries,
			...recursiveEntries.filter((entry) => {
				if (seenPaths.has(entry.path)) return false;
				seenPaths.add(entry.path);
				return true;
			}),
		];

		const scoredEntries = entries
			.map((entry) => ({
				path: entry.path,
				isDirectory: entry.isDirectory,
				score: fdQuery ? this.scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
			}))
			.filter((entry) => entry.score > 0);

		scoredEntries.sort((a, b) => {
			const scoreDiff = b.score - a.score;
			if (scoreDiff !== 0) return scoreDiff;

			const aDepth = toDisplayPath(a.path).split("/").filter(Boolean).length;
			const bDepth = toDisplayPath(b.path).split("/").filter(Boolean).length;
			const depthDiff = aDepth - bDepth;
			if (depthDiff !== 0) return depthDiff;

			const lengthDiff = a.path.length - b.path.length;
			if (lengthDiff !== 0) return lengthDiff;

			return a.path.localeCompare(b.path);
		});
		const topEntries = scoredEntries.slice(0, 20);

		const suggestions: AutocompleteItem[] = [];
		for (const { path: entryPath, isDirectory } of topEntries) {
			const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
			const displayPath = scopedQuery
				? this.scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
				: pathWithoutSlash;
			const entryName = basename(pathWithoutSlash);
			const completionPath = isDirectory ? `${displayPath}/` : displayPath;
			const value = buildCompletionValue(completionPath, {
				isDirectory,
				isAtPrefix: true,
				isQuotedPrefix: options.isQuotedPrefix,
			});

			suggestions.push({
				value,
				label: entryName + (isDirectory ? "/" : ""),
				description: displayPath,
			});
		}

		return suggestions;
	}

	// Check if we should trigger file completion (called on Tab key)
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}
}
