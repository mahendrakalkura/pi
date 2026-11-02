import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type InitialMessagesContext = {
	editor: { addToHistory: (text: string) => void };
	session: { prompt: (text: string, options?: unknown) => Promise<void> };
	showError: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	promptInitialMessages(
		this: InitialMessagesContext,
		initialMessage: string | undefined,
		initialImages: undefined,
		initialMessages: string[] | undefined,
	): Promise<void>;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("adds command-line prompts to editor history before sending them", async () => {
		const order: string[] = [];
		const context: InitialMessagesContext = {
			editor: { addToHistory: vi.fn((text: string) => void order.push(`history:${text}`)) },
			session: { prompt: vi.fn(async (text: string) => void order.push(`prompt:${text}`)) },
			showError: vi.fn(),
		};

		await interactiveModePrototype.promptInitialMessages.call(context, "first", undefined, ["second"]);

		expect(order).toEqual(["history:first", "prompt:first", "history:second", "prompt:second"]);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("keeps a failed command-line prompt in editor history", async () => {
		const context: InitialMessagesContext = {
			editor: { addToHistory: vi.fn() },
			session: {
				prompt: vi.fn(async () => {
					throw new Error("no model");
				}),
			},
			showError: vi.fn(),
		};

		await interactiveModePrototype.promptInitialMessages.call(context, "first", undefined, undefined);

		expect(context.editor.addToHistory).toHaveBeenCalledWith("first");
		expect(context.showError).toHaveBeenCalledWith("no model");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});
