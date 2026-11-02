import { describe, expect, it } from "vitest";
import {
	buildContextEntries,
	buildSessionProjection,
	type FileEntry,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

// The session manager keeps the projection of its leaf path between calls and extends it on append. Whatever happens to
// the session, it must answer what a projection built from scratch gives.

function walk(session: SessionManager): SessionEntry[] {
	const path: SessionEntry[] = [];
	for (let id = session.getLeafId(); id; ) {
		const entry = session.getEntry(id);
		if (!entry) break;
		path.push(entry);
		id = entry.parentId;
	}
	return path.reverse();
}

function sessionNameByScan(session: SessionManager): string | undefined {
	const entries = session.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "session_info") return entry.name?.trim() || undefined;
	}
	return undefined;
}

function seeded(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

function toolResult(text: string, toolCallId: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function systemMsg(text: string) {
	return { role: "system" as const, content: text, timestamp: Date.now() };
}

function randomStep(session: SessionManager, random: () => number, step: number): void {
	const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
	const path = walk(session);
	const roll = random();
	if (roll < 0.3 || path.length === 0) {
		const kind = random();
		if (kind < 0.4) session.appendMessage(userMsg(`u${step}`));
		else if (kind < 0.75) {
			const message = assistantMsg(`a${step}`);
			session.appendMessage(
				random() < 0.3 ? { ...message, provider: `p${step % 3}`, model: `m${step % 5}` } : message,
			);
		} else if (kind < 0.92) session.appendMessage(toolResult(`r${step}`, `call${step}`));
		else session.appendMessage(systemMsg(`system ${step}`));
	} else if (roll < 0.36) {
		session.appendThinkingLevelChange(pick(["off", "low", "high"]));
	} else if (roll < 0.41) {
		session.appendModelChange(`provider${step % 2}`, `model${step % 4}`);
	} else if (roll < 0.46) {
		session.appendCustomEntry("state", { step });
	} else if (roll < 0.52) {
		session.appendCustomMessageEntry(
			"note",
			random() < 0.5 ? `note ${step}` : [{ type: "text", text: `n${step}` }],
			random() < 0.5,
		);
	} else if (roll < 0.55) {
		session.appendSessionInfo(random() < 0.2 ? "  " : `name ${step}`);
	} else if (roll < 0.59) {
		session.appendLabelChange(pick(path).id, random() < 0.7 ? `label ${step}` : undefined);
	} else if (roll < 0.64) {
		const editable = path.filter(
			(entry) =>
				entry.type === "custom_message" ||
				(entry.type === "message" &&
					(entry.message.role === "user" ||
						entry.message.role === "assistant" ||
						entry.message.role === "toolResult")),
		);
		if (editable.length > 0) {
			session.appendContextEdit(pick(editable).id, random() < 0.3 ? null : { content: `edited ${step}` });
		}
	} else if (roll < 0.69) {
		session.appendCompaction(`summary ${step}`, random() < 0.1 ? null : pick(path).id, 1000);
	} else if (roll < 0.79) {
		session.branch(pick(session.getEntries()).id);
	} else if (roll < 0.81) {
		session.resetLeaf();
	} else if (roll < 0.86) {
		session.branchWithSummary(random() < 0.1 ? null : pick(path).id, `branch summary ${step}`);
	} else if (roll < 0.87 && path.length > 0) {
		session.createBranchedSession(pick(path).id);
	} else {
		// Several appends between two reads: the cache has to catch up over more than one entry.
		const count = 1 + Math.floor(random() * 5);
		for (let i = 0; i < count; i++)
			session.appendMessage(i % 2 ? assistantMsg(`b${step}.${i}`) : userMsg(`b${step}.${i}`));
	}
}

describe("SessionManager projection cache", () => {
	it("answers what a projection built from scratch gives", () => {
		for (const seed of [1, 7, 42, 1234, 99991]) {
			const random = seeded(seed);
			const session = SessionManager.inMemory();
			let revision = session.getProjectionRevision();
			let previous = session.buildSessionProjection();
			for (let step = 0; step < 600; step++) {
				randomStep(session, random, step);
				// Read only now and then, so appends pile up between reads.
				if (random() < 0.35) continue;

				const entries = session.getEntries();
				const leafId = session.getLeafId();
				const expected = buildSessionProjection(entries, leafId);
				const projection = session.buildSessionProjection();
				expect(projection).toEqual(expected);
				expect(session.peekSessionProjection()).toEqual(expected);
				expect(session.buildSessionContext()).toEqual({
					messages: expected.messages,
					thinkingLevel: expected.thinkingLevel,
					model: expected.model,
				});
				expect(session.getBranch()).toEqual(walk(session));
				expect(session.buildContextEntries()).toEqual(buildContextEntries(entries, leafId));
				expect(session.getSessionName()).toBe(sessionNameByScan(session));

				// The revision changes whenever the projection may have.
				const nextRevision = session.getProjectionRevision();
				if (nextRevision === revision) expect(projection).toEqual(previous);
				revision = nextRevision;
				previous = projection;
			}
		}
	});

	it("matches a session loaded from the same entries", () => {
		const random = seeded(5);
		const session = SessionManager.inMemory();
		for (let step = 0; step < 300; step++) randomStep(session, random, step);
		const header = session.getHeader();
		expect(header).not.toBeNull();
		const loaded = SessionManager.inMemory(undefined, undefined, [header as FileEntry, ...session.getEntries()]);
		// A loaded session's leaf is the last entry.
		const entries = session.getEntries();
		expect(loaded.buildSessionProjection()).toEqual(buildSessionProjection(entries, entries[entries.length - 1].id));
		expect(loaded.getSessionName()).toBe(sessionNameByScan(session));
	});

	it("hands out copies that do not change the cache", () => {
		const session = SessionManager.inMemory();
		session.appendModelChange("p", "m");
		session.appendMessage(userMsg("one"));
		session.appendMessage(assistantMsg("two"));
		const first = session.buildSessionProjection();
		first.messages.push(userMsg("injected"));
		first.entries.pop();
		if (first.model) first.model.modelId = "changed";
		first.thinkingLevel = "high";
		const second = session.buildSessionProjection();
		expect(second.messages).toHaveLength(2);
		expect(second.entries).toHaveLength(3);
		expect(second.model).toEqual({ provider: "anthropic", modelId: "test" });
		expect(second.thinkingLevel).toBe("off");
		expect(second).toEqual(buildSessionProjection(session.getEntries(), session.getLeafId()));
	});

	it("keeps the revision while nothing changes", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("one"));
		const revision = session.getProjectionRevision();
		session.buildSessionProjection();
		session.getBranch();
		expect(session.getProjectionRevision()).toBe(revision);
		session.appendMessage(assistantMsg("two"));
		expect(session.getProjectionRevision()).not.toBe(revision);
	});
});
