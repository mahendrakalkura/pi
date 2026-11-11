import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type FollowUpContext = {
	editor: {
		getText: () => string;
		onSubmit?: (text: string) => void;
		setText: (text: string) => void;
		submit?: () => void;
	};
	session: { isCompacting: boolean; isStreaming: boolean };
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleFollowUp(this: FollowUpContext): Promise<void>;
};

function createContext(): FollowUpContext {
	return {
		editor: { getText: () => "follow-up text", onSubmit: vi.fn(), setText: vi.fn(), submit: vi.fn() },
		session: { isCompacting: false, isStreaming: false },
	};
}

describe("InteractiveMode Alt+Enter while idle", () => {
	it("submits through the editor's own Enter step", async () => {
		const context = createContext();

		await interactiveModePrototype.handleFollowUp.call(context);

		expect(context.editor.submit).toHaveBeenCalledOnce();
		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.editor.onSubmit).not.toHaveBeenCalled();
	});

	it("falls back to onSubmit for an editor without submit()", async () => {
		const context = createContext();
		context.editor.submit = undefined;

		await interactiveModePrototype.handleFollowUp.call(context);

		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.editor.onSubmit).toHaveBeenCalledWith("follow-up text");
	});
});
