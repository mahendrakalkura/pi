import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type RegisteredCommand = {
	invocationName: string;
	name: string;
	sourceInfo: { path: string; scope: string; source: string };
};

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { addToHistory: (text: string) => void; setText: (text: string) => void };
	handleModelCommand: (searchTerm?: string) => Promise<void>;
	isExtensionCommand: (text: string) => boolean;
	submitPrompt: (text: string) => Promise<void>;
};

type AutocompleteContext = {
	fdPath: undefined;
	getAutocompleteSourceTag: (sourceInfo?: unknown) => string | undefined;
	prefixAutocompleteDescription: (description: string | undefined, sourceInfo?: unknown) => string | undefined;
	session: {
		extensionRunner: { getRegisteredCommands: () => Array<RegisteredCommand & { description: string }> };
		promptTemplates: [];
		resourceLoader: { getSkills: () => { skills: [] } };
	};
	sessionManager: { getCwd: () => string };
	settingsManager: { getEnableSkillCommands: () => boolean };
	skillCommands: Map<string, string>;
};

type InteractiveModePrivate = {
	createBaseAutocompleteProvider(this: AutocompleteContext): {
		commands: Array<{ description?: string; name: string }>;
	};
	getAutocompleteSourceTag(sourceInfo?: unknown): string | undefined;
	prefixAutocompleteDescription(description: string | undefined, sourceInfo?: unknown): string | undefined;
	getBuiltInCommandConflictDiagnostics(
		this: unknown,
		extensionRunner: { getRegisteredCommands: () => RegisteredCommand[] },
	): Array<{ message: string; path?: string; type: string }>;
	setupEditorSubmitHandler(this: SubmitContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(extensionCommands: string[]): SubmitContext {
	return {
		defaultEditor: {},
		editor: { addToHistory: vi.fn(), setText: vi.fn() },
		handleModelCommand: vi.fn(async () => {}),
		isExtensionCommand: (text) => extensionCommands.includes(text.slice(1).split(" ")[0] ?? ""),
		submitPrompt: vi.fn(async () => {}),
	};
}

function command(name: string, invocationName = name): RegisteredCommand {
	return {
		invocationName,
		name,
		sourceInfo: { path: `/extensions/${invocationName}.ts`, scope: "user", source: "builtin" },
	};
}

describe("InteractiveMode built-in command override", () => {
	it("sends a command an extension registered under a built-in's name to the extension, with its argument", async () => {
		const context = createSubmitContext(["model"]);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/model");
		await context.defaultEditor.onSubmit?.(" /model opus ");

		expect(context.submitPrompt).toHaveBeenNthCalledWith(1, "/model");
		expect(context.submitPrompt).toHaveBeenNthCalledWith(2, "/model opus");
		expect(context.handleModelCommand).not.toHaveBeenCalled();
	});

	it("keeps the built-in when no extension takes its name", async () => {
		const context = createSubmitContext([]);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/model opus");

		expect(context.handleModelCommand).toHaveBeenCalledWith("opus");
		expect(context.submitPrompt).not.toHaveBeenCalled();
	});

	it("lists the replacing extension command in autocomplete instead of the built-in", () => {
		const context: AutocompleteContext = {
			fdPath: undefined,
			getAutocompleteSourceTag: interactiveModePrototype.getAutocompleteSourceTag,
			prefixAutocompleteDescription: interactiveModePrototype.prefixAutocompleteDescription,
			session: {
				extensionRunner: { getRegisteredCommands: () => [{ ...command("model"), description: "Model table" }] },
				promptTemplates: [],
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			sessionManager: { getCwd: () => "/tmp" },
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
		};

		const provider = interactiveModePrototype.createBaseAutocompleteProvider.call(context);
		const modelEntries = provider.commands.filter((entry) => entry.name === "model");

		expect(modelEntries).toEqual([expect.objectContaining({ description: "Model table", name: "model" })]);
		expect(provider.commands.some((entry) => entry.name === "settings")).toBe(true);
	});

	it("warns only about duplicates that had to take a suffixed name", () => {
		const replacing = interactiveModePrototype.getBuiltInCommandConflictDiagnostics.call(undefined, {
			getRegisteredCommands: () => [command("model"), command("accounts")],
		});
		const duplicated = interactiveModePrototype.getBuiltInCommandConflictDiagnostics.call(undefined, {
			getRegisteredCommands: () => [command("model", "model:1"), command("model", "model:2")],
		});

		expect(replacing).toEqual([]);
		expect(duplicated.map((diagnostic) => diagnostic.message)).toEqual([
			"Extension command '/model' conflicts with built-in interactive command. Available as '/model:1'.",
			"Extension command '/model' conflicts with built-in interactive command. Available as '/model:2'.",
		]);
	});
});
