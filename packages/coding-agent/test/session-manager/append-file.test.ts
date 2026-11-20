import { fstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

/** How many file descriptors of this process are open on `file`, where the platform lists them. */
function openCount(file: string): number | undefined {
	const { dev, ino } = statSync(file);
	for (const dir of ["/dev/fd", "/proc/self/fd"]) {
		let fds: string[];
		try {
			fds = readdirSync(dir);
		} catch {
			continue;
		}
		return fds.filter((fd) => {
			try {
				const stats = fstatSync(Number(fd));
				return stats.dev === dev && stats.ino === ino;
			} catch {
				return false;
			}
		}).length;
	}
	return undefined;
}

const jsonl = (entries: unknown[]) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

describe("SessionManager appends", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-session-append-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function startSession(): { session: SessionManager; file: string } {
		const session = SessionManager.create(dir, dir);
		session.appendMessage(userMsg("first"));
		return { session, file: session.getSessionFile()! };
	}

	it("writes each entry as one JSON line, as the session holds it", () => {
		const { session, file } = startSession();
		session.appendMessage(assistantMsg("answer"));
		session.appendCustomEntry("ext", { text: "multi\nline   \ud83d" });
		session.appendSessionInfo("name");
		session.appendMessage(userMsg("x".repeat(200_000)));
		expect(readFileSync(file, "utf8")).toBe(jsonl([session.getHeader(), ...session.getEntries()]));
		// Each entry is in the file when its append returns.
		session.appendMessage(assistantMsg("last"));
		expect(readFileSync(file, "utf8").endsWith(`${JSON.stringify(session.getEntries().at(-1))}\n`)).toBe(true);
	});

	it("appends to a new file at the path when the file was deleted", () => {
		const { session, file } = startSession();
		session.appendMessage(assistantMsg("answer"));
		rmSync(file);
		session.appendMessage(userMsg("after delete"));
		expect(readFileSync(file, "utf8")).toBe(jsonl([session.getEntries().at(-1)]));
	});

	it("appends to the file that replaced the session file", () => {
		const { session, file } = startSession();
		session.appendMessage(assistantMsg("answer"));
		const before = readFileSync(file, "utf8");
		writeFileSync(`${file}.new`, before);
		renameSync(`${file}.new`, file);
		session.appendMessage(userMsg("after replace"));
		expect(readFileSync(file, "utf8")).toBe(jsonl([session.getHeader(), ...session.getEntries()]));
	});

	it("appends after the file was truncated and rewritten in place", () => {
		const { session, file } = startSession();
		session.appendMessage(assistantMsg("answer"));
		writeFileSync(file, `${JSON.stringify(session.getHeader())}\n`);
		session.appendMessage(userMsg("after rewrite"));
		expect(readFileSync(file, "utf8")).toBe(jsonl([session.getHeader(), session.getEntries().at(-1)]));
	});

	it("keeps whole lines when two managers append to one file", () => {
		const { session, file } = startSession();
		session.appendMessage(assistantMsg("answer"));
		const other = SessionManager.open(file, dir);
		for (let i = 0; i < 20; i++) {
			session.appendMessage(userMsg(`a${i}`));
			other.appendMessage(userMsg(`b${i}`));
		}
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(43);
		expect(lines.map((line) => JSON.parse(line).message?.content).filter(Boolean)).toHaveLength(42);
	});

	it.skipIf(!["darwin", "linux"].includes(process.platform))(
		"closes the file when the session changes and after appends stop",
		async () => {
			const { session, file } = startSession();
			session.appendMessage(assistantMsg("answer"));
			expect(openCount(file)).toBe(1);
			session.newSession();
			expect(openCount(file)).toBe(0);

			const { session: second, file: secondFile } = startSession();
			second.appendMessage(assistantMsg("answer"));
			expect(openCount(secondFile)).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 1300));
			expect(openCount(secondFile)).toBe(0);
			// Appends after the close open the file again.
			second.appendMessage(userMsg("later"));
			expect(readFileSync(secondFile, "utf8")).toBe(jsonl([second.getHeader(), ...second.getEntries()]));
		},
	);
});
