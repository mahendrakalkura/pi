import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { formatSkillInvocation } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo, SessionMessageEntry } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// A skill body longer than the tree selector's 200-character label cut.
const SKILL_BLOCK = `<skill name="review-all" location="/skills/review-all/SKILL.md">\n${"Review every open merge request. ".repeat(10)}\n</skill>`;

describe("skill invocation labels", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("maps a skill block to its command and passes other text through", () => {
		expect(formatSkillInvocation(SKILL_BLOCK)).toBe("/skill:review-all");
		expect(formatSkillInvocation(`${SKILL_BLOCK}\n\nonly mine`)).toBe("/skill:review-all only mine");
		expect(formatSkillInvocation("plain prompt")).toBe("plain prompt");
	});

	it("shows the skill command in the resume picker", async () => {
		const session: SessionInfo = {
			allMessagesText: SKILL_BLOCK,
			created: new Date(0),
			cwd: "",
			firstMessage: `${SKILL_BLOCK}\n\nonly mine`,
			id: "a",
			messageCount: 1,
			modified: new Date(0),
			path: "/tmp/a.jsonl",
		};
		const selector = new SessionSelectorComponent(
			async () => [session],
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), showRenameHint: false },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const output = selector.render(160).map(stripVTControlCharacters).join("\n");
		expect(output).toContain("/skill:review-all only mine");
		expect(output).not.toContain("<skill");
	});

	it("shows the skill command in the session tree", () => {
		const entry: SessionMessageEntry = {
			id: "user-1",
			message: { content: SKILL_BLOCK, role: "user", timestamp: 0 },
			parentId: null,
			timestamp: new Date(0).toISOString(),
			type: "message",
		};
		const selector = new TreeSelectorComponent(
			[{ children: [], entry }],
			"user-1",
			24,
			() => {},
			() => {},
		);

		const output = selector.getTreeList().render(160).map(stripVTControlCharacters).join("\n");
		expect(output).toContain("user: /skill:review-all");
		expect(output).not.toContain("<skill");
	});
});
