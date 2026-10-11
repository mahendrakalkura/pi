import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * A Markdown block of the last update. The next update reuses it at the same position for the same kind of content, so
 * a streamed answer keeps the blocks it already rendered, also once the stream ends.
 */
interface MarkdownSlot {
	kind: "text" | "thinking";
	markdown: Markdown;
}

/** Whether `text` contains one of `names` (lowercase), ignoring case. */
export function mentionsAny(text: string, names: ReadonlySet<string>): boolean {
	if (names.size === 0 || text === "") return false;
	const lower = text.toLowerCase();
	for (const name of names) {
		if (lower.includes(name)) return true;
	}
	return false;
}

/** A Markdown component of an assistant message, with what it was made from (AssistantMessageComponent.markdownFor()). */
interface MarkdownBlock {
	kind: "text" | "thinking";
	text: string;
	isStreaming: boolean;
	outputPad: number;
	component: Markdown;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private messageId?: string;
	private timestamp?: string;
	private contentIsStale = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private markdownSlots: MarkdownSlot[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/**
	 * Whether this message may show code highlighted in one of `languages` (lowercase names): whether its text names one
	 * of them anywhere, which every code block in that language does. Markdown transformers (extensions) may add any.
	 */
	mayHighlight(languages: ReadonlySet<string>): boolean {
		if (this.markdownTransformers.length > 0) return true;
		const content = this.lastMessage?.content ?? [];
		return content.some((block) => {
			const text = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "";
			return mentionsAny(text, languages);
		});
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		// Markdown takes its padding at construction.
		this.markdownSlots = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override renderShared(width: number): string[] {
		if (this.contentIsStale && this.lastMessage) this.buildContent(this.lastMessage);
		const lines = super.renderShared(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}
		// The marked lines are kept with the lines they were made from: same lines, same array (renderShared()).
		if (lines !== this.markedFrom) {
			const marked = lines.slice();
			marked[0] = OSC133_ZONE_START + marked[0];
			marked[marked.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[marked.length - 1];
			this.markedFrom = lines;
			this.markedLines = marked;
		}
		return this.markedLines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		// While a reply streams, every delta of it comes here, and the screen is drawn a few dozen times a second at most: the
		// components are made when it is (render()), from the latest message, not for each delta (and its text trimmed, a
		// copy of all of it so far, each time).
		if (isStreaming) {
			this.contentIsStale = true;
			return;
		}
		this.buildContent(message);
	}

	/** A Markdown component for `text`: the one built for it before when nothing it was made with has changed. */
	private markdownFor(
		kind: MarkdownBlock["kind"],
		text: string,
		previous: MarkdownBlock[],
		create: () => Markdown,
	): Markdown {
		const index = previous.findIndex(
			(block) =>
				block.kind === kind &&
				block.text === text &&
				block.isStreaming === this.isStreaming &&
				block.outputPad === this.outputPad,
		);
		const component = index === -1 ? create() : previous.splice(index, 1)[0]!.component;
		this.markdownBlocks.push({ kind, text, isStreaming: this.isStreaming, outputPad: this.outputPad, component });
		return component;
	}

	private buildContent(message: AssistantMessage): void {
		this.contentIsStale = false;
		const previousBlocks = this.markdownBlocks;
		this.markdownBlocks = [];
		// Clear content container
		this.contentContainer.clear();
		const previousSlots = this.markdownSlots;
		this.markdownSlots = [];
		const markdownBlock = (kind: MarkdownSlot["kind"], text: string, create: () => Markdown): Markdown => {
			const slot = previousSlots[this.markdownSlots.length];
			const markdown = slot?.kind === kind ? slot.markdown : create();
			markdown.setText(text);
			this.markdownSlots.push({ kind, markdown });
			return markdown;
		};

		// Spacers are added lazily, right before the next visible content block. This puts a blank
		// line before the first visible block and after each visible thinking run that is followed
		// by more visible content, while hidden thinking runs without a label contribute nothing.
		let needsSpacer = true;
		const addVisibleChild = (child: Component) => {
			if (needsSpacer) {
				this.contentContainer.addChild(new Spacer(1));
				needsSpacer = false;
			}
			this.contentContainer.addChild(child);
		};

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const text = content.text.trim();
				addVisibleChild(
					markdownBlock(
						"text",
						text,
						() =>
							new Markdown(text, this.outputPad, 0, this.markdownTheme, undefined, {
								transform: createMarkdownTransform(
									"assistant",
									() => this.isStreaming,
									this.markdownTransformers,
									this.messageId,
									this.timestamp,
								),
							}),
					),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				// A hidden run with an empty label renders nothing, including no spacing.
				if (hidden && !this.hiddenThinkingLabel.trim()) {
					continue;
				}
				const thinking = thinkingBlocks.join("\n\n");
				const thinkingComponent = hidden
					? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
					: markdownBlock(
							"thinking",
							thinking,
							() =>
								new Markdown(
									thinking,
									this.outputPad,
									0,
									this.markdownTheme,
									{
										color: (text: string) => theme.fg("thinkingText", text),
										italic: true,
									},
									{
										transform: createMarkdownTransform(
											"assistant-thinking",
											() => this.isStreaming,
											this.markdownTransformers,
											this.messageId,
											this.timestamp,
										),
									},
								),
						);
				addVisibleChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				needsSpacer = true;
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
