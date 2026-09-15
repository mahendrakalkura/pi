import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

// A box-table data row splits into cells around "│"; drop the two empty ends.
function rowCells(line: string): string[] {
	return line
		.split("│")
		.slice(1, -1)
		.map((cell) => cell.trim());
}

// The Model cell of the row the selection marker is on.
function selectedModelId(selector: ModelSelectorComponent): string | undefined {
	const row = stripAnsi(selector.render(120).join("\n"))
		.split("\n")
		.map(rowCells)
		.find((cells) => cells[0]?.startsWith("→"));
	return row?.[3];
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const browsedModel = harness.getModel("browsed-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[{ model: currentModel }, { model: browsedModel }],
			() => {},
			() => {},
		);

		// The marker cell is the first cell of the box-table row.
		const getModelRow = (id: string): string | undefined => {
			const line = stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((candidate) => candidate.includes(` ${id} `));
			return line ? rowCells(line)[0] : undefined;
		};

		expect(getModelRow("current-model")).toBe("→ ✓");
		selector.handleInput("\x1b[A");
		expect(getModelRow("current-model")).toBe("✓");
		expect(getModelRow("browsed-model")).toBe("→");
		selector.dispose();
	});

	it("stops at the list ends instead of wrapping", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const browsedModel = harness.getModel("browsed-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[{ model: currentModel }, { model: browsedModel }],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined => {
			const line = stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((candidate) => candidate.includes(` ${id} `));
			return line ? rowCells(line)[0] : undefined;
		};

		// Sorted list is [browsed-model, current-model]; selection starts on current-model (bottom).
		// Down at the bottom stays at the bottom.
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe("→ ✓");
		// Up moves to the top; up again at the top stays at the top.
		selector.handleInput("\x1b[A");
		expect(getModelRow("browsed-model")).toBe("→");
		selector.handleInput("\x1b[A");
		expect(getModelRow("browsed-model")).toBe("→");
		selector.dispose();
	});

	it("renders every scoped model without scope controls or status lines", async () => {
		const models = Array.from({ length: 12 }, (_, index) => ({
			id: `model-${String(index).padStart(2, "0")}`,
			name: `Model ${index}`,
			reasoning: true,
		}));
		harness = await createHarness({
			models: [...models, { id: "catalog-only", name: "Catalog Only", reasoning: true }],
		});
		const scopedModels = models.map(({ id }) => ({ model: harness!.getModel(id)! }));
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			scopedModels[0].model,
			harness.session.modelRuntime,
			scopedModels,
			() => {},
			() => {},
		);

		selector.handleInput("\t");
		const rendered = stripAnsi(selector.render(160).join("\n"));
		for (const { id } of models) expect(rendered).toContain(id);
		expect(rendered).not.toContain("catalog-only");
		expect(rendered).toContain("Model");
		expect(rendered).toContain("Provider");
		expect(rendered).toContain("Default");
		expect(rendered).not.toContain("Scope:");
		expect(rendered).not.toContain("(1/12)");
		expect(rendered).not.toContain("Model Name:");
		expect(rendered).not.toContain("Model catalogs refreshed.");
		selector.dispose();
	});

	it("moves by one page with remapped selection page keys (#7629)", async () => {
		setKeybindings(new KeybindingsManager({ "tui.select.pageUp": "alt+v", "tui.select.pageDown": "ctrl+v" }));
		harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({ id: `model-${String(index).padStart(2, "0")}` })),
		});
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
		);

		selector.handleInput("\x16"); // Ctrl+V
		selector.handleInput("\x16");
		selector.handleInput("\x1bv"); // Alt+V
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "model-01" }));
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	// #9109
	describe("when the catalog refresh lands", () => {
		// Opens the selector with the refresh in flight, so a test can browse first and then let it land.
		async function openWithPendingRefresh(): Promise<{
			activeHarness: Harness;
			selector: ModelSelectorComponent;
			finishRefresh: () => Promise<void>;
		}> {
			const activeHarness = await createHarness({
				models: [{ id: "alpha-1" }, { id: "alpha-2" }, { id: "alpha-3" }, { id: "beta-1" }],
			});
			harness = activeHarness;
			const { promise, resolve } = Promise.withResolvers<ModelsRefreshResult>();
			vi.spyOn(activeHarness.session.modelRuntime, "refresh").mockReturnValue(promise);
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				activeHarness.getModel("alpha-1"),
				activeHarness.session.modelRuntime,
				[],
				() => {},
				() => {},
			);
			const finishRefresh = async () => {
				resolve({ aborted: false, errors: new Map() });
				// The selector shows no notice for a successful refresh; one macrotask lets its continuation run.
				await promise;
				await new Promise((done) => setTimeout(done, 0));
			};
			return { activeHarness, selector, finishRefresh };
		}

		it("keeps the selection on the browsed model", async () => {
			const { selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");

			await finishRefresh();

			expect(selectedModelId(selector)).toBe("alpha-3");
			selector.dispose();
		});

		it("keeps the selection while a search query is active", async () => {
			const { selector, finishRefresh } = await openWithPendingRefresh();
			for (const char of "alpha") selector.handleInput(char);
			selector.handleInput("\x1b[B");
			const browsed = selectedModelId(selector);

			await finishRefresh();

			expect(selectedModelId(selector)).toBe(browsed);
			expect(browsed).not.toBe("alpha-1");
			selector.dispose();
		});

		it("follows the selected model when new rows shift its position", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const snapshot = modelRuntime.getAvailableSnapshot();
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([
				{ ...snapshot[0], id: "added-model" },
				...snapshot,
			]);

			await finishRefresh();

			expect(selectedModelId(selector)).toBe("alpha-2");
			// Rows sort by client, provider and model, so the row above alpha-2 is alpha-1.
			selector.handleInput("\x1b[A");
			expect(selectedModelId(selector)).toBe("alpha-1");
			selector.dispose();
		});

		it("falls back to the current model when the selected model disappears", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const remaining = modelRuntime.getAvailableSnapshot().filter((model) => model.id !== "alpha-2");
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue(remaining);

			await finishRefresh();

			expect(selectedModelId(selector)).toBe("alpha-1");
			selector.dispose();
		});
	});
});
