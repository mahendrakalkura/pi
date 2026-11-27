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
	submitPrompt: (text: string) => Promise<void>;
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type InitialMessagesContext = SubmitContext & {
	editor: { addToHistory: (text: string) => void; getText: () => string; setText: (text: string) => void };
	handleBashCommand: (command: string, excludeFromContext: boolean) => Promise<void>;
	handleNameCommand: (text: string) => void;
	isBashMode: boolean;
	isExtensionCommand: (text: string) => boolean;
	showError: (message: string) => void;
	submitInitialMessage: (text: string) => Promise<void>;
	renderer: { getFocusedComponent: () => unknown };
	updateEditorBorderColor: () => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	promptInitialMessages(
		this: InitialMessagesContext,
		initialMessage: string | undefined,
		initialImages: Array<{ data: string; mimeType: string; type: "image" }> | undefined,
		initialMessages: string[] | undefined,
	): Promise<void>;
	setupEditorSubmitHandler(this: SubmitContext): void;
	submitInitialMessage(this: InitialMessagesContext, text: string): Promise<void>;
	submitPrompt(this: SubmitContext, text: string): Promise<void>;
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
		submitPrompt: interactiveModePrototype.submitPrompt,
	};
}

function createInitialMessagesContext(): InitialMessagesContext {
	const context = {
		...createSubmitContext(),
		editor: { addToHistory: vi.fn(), getText: () => "", setText: vi.fn() },
		handleBashCommand: vi.fn(async () => {}),
		handleNameCommand: vi.fn(),
		isBashMode: false,
		isExtensionCommand: () => false,
		showError: vi.fn(),
		submitInitialMessage: interactiveModePrototype.submitInitialMessage,
		renderer: { getFocusedComponent: (): unknown => context.editor },
		updateEditorBorderColor: vi.fn(),
	};
	interactiveModePrototype.setupEditorSubmitHandler.call(context);
	return context;
}

/** Record history, prompt, bash, and built-in calls in the order they happen. */
function recordOrder(context: InitialMessagesContext): string[] {
	const order: string[] = [];
	context.editor.addToHistory = vi.fn((text: string) => void order.push(`history:${text}`));
	context.session.prompt = vi.fn(async (text: string) => void order.push(`prompt:${text}`));
	context.handleBashCommand = vi.fn(async (command: string) => void order.push(`bash:${command}`));
	context.handleNameCommand = vi.fn((text: string) => void order.push(`name:${text}`));
	return order;
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

	it("adds a built-in command to editor history before running it", async () => {
		const order: string[] = [];
		const context = {
			...createSubmitContext(),
			handleNameCommand: vi.fn((text: string) => void order.push(`run:${text}`)),
			isExtensionCommand: () => false,
		};
		context.editor.addToHistory = vi.fn((text: string) => void order.push(`history:${text}`));
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" /name session label ");

		expect(order).toEqual(["history:/name session label", "run:/name session label"]);
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("sends command-line prompts through the submit handler, each finishing before the next", async () => {
		const context = createInitialMessagesContext();
		const order = recordOrder(context);

		await interactiveModePrototype.promptInitialMessages.call(context, "first", undefined, [
			"!echo hi",
			"/name label",
			"second",
		]);

		expect(order).toEqual([
			"history:first",
			"prompt:first",
			"history:!echo hi",
			"bash:echo hi",
			"history:/name label",
			"name:/name label",
			"history:second",
			"prompt:second",
		]);
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("keeps a failed command-line prompt in editor history", async () => {
		const context = createInitialMessagesContext();
		context.session.prompt = vi.fn(async () => {
			throw new Error("no model");
		});

		await interactiveModePrototype.promptInitialMessages.call(context, "first", undefined, undefined);

		expect(context.editor.addToHistory).toHaveBeenCalledWith("first");
		expect(context.showError).toHaveBeenCalledWith("no model");
	});

	it("sends a first prompt with images directly, since the submit handler takes text only", async () => {
		const context = createInitialMessagesContext();
		const images = [{ data: "aGk=", mimeType: "image/png", type: "image" as const }];

		await interactiveModePrototype.promptInitialMessages.call(context, "look", images, undefined);

		expect(context.editor.addToHistory).toHaveBeenCalledWith("look");
		expect(context.session.prompt).toHaveBeenCalledWith("look", { images });
	});

	it("sends a prompt typed meanwhile before the next command-line prompt", async () => {
		const context = createInitialMessagesContext();
		const order = recordOrder(context);
		context.pendingUserInputs.push("typed during startup");

		await interactiveModePrototype.promptInitialMessages.call(context, "first", undefined, ["second"]);

		expect(order).toEqual([
			"history:first",
			"prompt:typed during startup",
			"prompt:first",
			"history:second",
			"prompt:second",
		]);
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("holds the next command-line prompt until a built-in selector hands the keyboard back", async () => {
		vi.useFakeTimers();
		try {
			const context = createInitialMessagesContext();
			const order = recordOrder(context);
			const selector = {};
			let focused: unknown = context.editor;
			context.renderer.getFocusedComponent = () => focused;
			context.handleNameCommand = vi.fn((text: string) => {
				order.push(`name:${text}`);
				focused = selector;
			});

			const done = interactiveModePrototype.promptInitialMessages.call(context, "/name label", undefined, ["next"]);
			await vi.advanceTimersByTimeAsync(500);
			expect(order).toEqual(["history:/name label", "name:/name label"]);

			focused = context.editor;
			await vi.advanceTimersByTimeAsync(100);
			await done;
			expect(order).toEqual(["history:/name label", "name:/name label", "history:next", "prompt:next"]);
		} finally {
			vi.useRealTimers();
		}
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
