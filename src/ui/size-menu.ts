/**
 * Size presets for one embed — the precise (and touch-friendly) companion
 * to dragging: "Fit to column", 50 % / 33 % of the column, original size
 * and an exact width. Opened by right-click or long-press on a resize
 * handle (our own element, so Obsidian's native image context menu is
 * left untouched). Every entry goes through the SAME write path as a drag:
 * beginDrag probe first, then commit — identical safety invariants.
 */

import { Menu, Modal, Notice, Setting, type App } from "obsidian";
import { measureContainingBlock } from "../core/column";
import type { SizeSpec } from "../core/parse";
import { parseWidthInput, presetSize, type SizePreset } from "../core/session";
import type { EmbedHit, HoverAdapter } from "./attach";
import type { OverlayOptions } from "./overlay";

const CANNOT_RESIZE_NOTICE = "Scalosaurus: this image can't be resized here.";

export function openSizeMenu(
	app: App,
	evt: MouseEvent,
	hit: EmbedHit,
	options: OverlayOptions,
	adapter: HoverAdapter,
): void {
	const apply = async (size: SizeSpec): Promise<void> => {
		if (!adapter.beginDrag(hit.embedEl, hit.visual)) {
			new Notice(CANNOT_RESIZE_NOTICE);
			return;
		}
		await adapter.commit(hit.embedEl, hit.visual, size);
	};
	// Measured now, while the embed is certainly laid out.
	const column = measureContainingBlock(hit.embedEl)?.width ?? null;
	const sizeFor = (preset: SizePreset) =>
		presetSize(preset, column, {
			sentinelMode: options.sentinelMode,
			minWidth: options.minWidth,
		});

	const menu = new Menu();
	const presets: Array<[SizePreset, string, string]> = [
		["fit", "Fit to column", "maximize-2"],
		["half", "50% of column", "minimize-2"],
		["third", "33% of column", "minimize-2"],
		["original", "Original size", "image"],
	];
	for (const [preset, title, icon] of presets) {
		const size = sizeFor(preset);
		if (!size) continue;
		menu.addItem((item) =>
			item
				.setTitle(title)
				.setIcon(icon)
				.onClick(() => void apply(size)),
		);
	}
	menu.addItem((item) =>
		item
			.setTitle("Set width…")
			.setIcon("pencil")
			.onClick(() => {
				new WidthModal(app, (width) => void apply({ kind: "width", width })).open();
			}),
	);
	menu.showAtMouseEvent(evt);
}

class WidthModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private readonly onSubmit: (width: number) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Set image width");
		const submit = () => {
			const width = parseWidthInput(this.value);
			if (width === null) {
				new Notice("Scalosaurus: enter a width in pixels, e.g. 400.");
				return;
			}
			this.close();
			this.onSubmit(width);
		};
		new Setting(this.contentEl).setName("Width in pixels").addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.setPlaceholder("400").onChange((v) => (this.value = v));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton((btn) =>
			btn.setButtonText("Apply").setCta().onClick(submit),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
