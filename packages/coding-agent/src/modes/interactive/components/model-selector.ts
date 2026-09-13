import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import Table from "cli-table3";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

interface DefaultModelReference {
	provider: string;
	id: string;
}

type ModelScope = "all" | "scoped";

// Provider ids carry an account owner: subscription accounts as <vendor>-<owner>, API-key
// providers as <owner>-<vendor>. Unlabeled ids sort and display with an empty client column.
const ACCOUNT_OWNERS = new Set(["jg", "mk", "nr"]);
const NATURAL_ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
// Rows of the selector that are not table rows: borders, spacers, search input, hint, table head and frame.
const SELECTOR_CHROME_ROWS = 12;
const MIN_TABLE_ROWS = 5;

export function splitProvider(provider: string): { client: string; vendor: string } {
	const dash = provider.indexOf("-");
	if (dash === -1) return { client: "", vendor: provider };
	const head = provider.slice(0, dash);
	const tail = provider.slice(dash + 1);
	if (ACCOUNT_OWNERS.has(head)) return { client: head, vendor: tail };
	if (ACCOUNT_OWNERS.has(tail)) return { client: tail, vendor: head };
	return { client: "", vendor: provider };
}

/** Start of the window of `size` rows that keeps `selected` visible, centered when possible. */
export function windowStart(selected: number, size: number, total: number): number {
	if (total <= size) return 0;
	return Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
}

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	private scope: ModelScope = "all";
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
		defaultModel?: DefaultModelReference,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// The scoped list (settings.enabledModels) is the only view; there is no toggle to the full catalog.
		if (scopedModels.length === 0) {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
			this.addChild(new Spacer(1));
		}

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Hint
		if (this.onSelectAsDefaultCallback) {
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						`  ${keyDisplayText("tui.select.confirm")} to select · ${keyDisplayText("app.models.save")} to set as default · ${keyDisplayText("tui.select.cancel")} to cancel`,
					),
					0,
					0,
				),
			);
		}

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		if (initialSearchInput) this.filterModels(initialSearchInput);
		else this.updateList();
		this.tui.requestRender();
		void this.refreshModels();
	}

	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.sortModels(
			this.scopedModels.map((scoped) => ({
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
			})),
		);
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
			}
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue());
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	// Client, then vendor, then model id in natural order (4-5 sorts before 5, 5.6 before 5.10).
	private sortModels(models: ModelItem[]): ModelItem[] {
		return [...models].sort((a, b) => {
			const left = splitProvider(a.provider);
			const right = splitProvider(b.provider);
			return (
				NATURAL_ORDER.compare(left.client, right.client) ||
				NATURAL_ORDER.compare(left.vendor, right.vendor) ||
				NATURAL_ORDER.compare(a.id, b.id)
			);
		});
	}

	private tableRows(): number {
		const terminalRows = this.tui.terminal?.rows ?? 24;
		return Math.max(MIN_TABLE_ROWS, terminalRows - SELECTOR_CHROME_ROWS);
	}

	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	private isDefaultSearch(query: string): boolean {
		const normalized = query.trim().toLowerCase();
		return normalized.length > 0 && "default".startsWith(normalized);
	}

	private filterModels(query: string): void {
		if (query) {
			const filtered = fuzzyFilter(this.activeModels, query, (item) => {
				const defaultText = this.isDefaultModel(item.model) ? " default" : "";
				return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
			});
			if (this.isDefaultSearch(query)) {
				const defaultItems = this.activeModels.filter((item) => this.isDefaultModel(item.model));
				const defaultKeys = new Set(defaultItems.map((item) => `${item.provider}\0${item.id}`));
				this.filteredModels = [
					...defaultItems,
					...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
				];
			} else {
				this.filteredModels = filtered;
			}
		} else {
			this.filteredModels = this.activeModels;
		}
		// When filtering by a query, move the selector to the top row so the best
		// match is highlighted. When the query is cleared, keep the current position
		// clamped to the (restored) list length.
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	// Every filtered model is rendered as one row of an aligned ASCII table; nothing scrolls and no
	// per-selection detail line is shown. Errors from the catalog refresh still surface below the table.
	// A box-drawn table (cli-table3) of the filtered models, windowed to the rows the terminal can show
	// with the selection kept in view. No per-selection detail line; refresh errors surface below.
	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredModels.length > 0) {
			const size = this.tableRows();
			const start = windowStart(this.selectedIndex, size, this.filteredModels.length);
			const table = new Table({
				head: ["", "Client", "Provider", "Model", "Name", "Default"],
				style: { head: [], border: [], "padding-left": 1, "padding-right": 1 },
			});
			for (const [index, item] of this.filteredModels.slice(start, start + size).entries()) {
				const absolute = start + index;
				const isSelected = absolute === this.selectedIndex;
				const cursor = isSelected ? "→" : " ";
				const currentMarker = modelsAreEqual(this.currentModel, item.model) ? "✓" : " ";
				const { client, vendor } = splitProvider(item.provider);
				const cells = [client, vendor, item.id, item.model.name, this.isDefaultModel(item.model) ? "default" : ""];
				table.push([
					theme.fg("accent", `${cursor} ${currentMarker}`),
					...cells.map((cell) => (isSelected ? theme.fg("accent", cell) : cell)),
				]);
			}
			for (const line of table.toString().split("\n")) {
				this.listContainer.addChild(new Text(line, 0, 0));
			}
		}

		if (this.errorMessage) {
			for (const line of this.errorMessage.split("\n")) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Tab used to toggle between the scoped list and the full catalog; the scoped list is now the only view.
		if (kb.matches(keyData, "tui.input.tab")) {
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.dispose();
			this.onCancelCallback();
		}
		// Select and save as default
		else if (kb.matches(keyData, "app.models.save") && this.onSelectAsDefaultCallback) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.dispose();
				this.onSelectAsDefaultCallback(selectedModel.model);
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		this.dispose();
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
