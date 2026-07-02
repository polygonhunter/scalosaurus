import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { SentinelMode, SnapConfig } from "./core/session";

export type UnlockModifier = "shift" | "alt" | "ctrl" | "meta";

export interface ScalosaurusSettings {
	snapEnabled: boolean;
	snapInThreshold: number;
	snapOutThreshold: number;
	/** What a snapped commit writes: |100%, |fit, or measured px (opt-out). */
	sentinelMode: SentinelMode;
	unlockModifier: UnlockModifier;
	minWidth: number;
	readingModeEnabled: boolean;
	/** Suppress Obsidian's native (>= 1.12) corner-drag while our UI is up. */
	suppressNative: boolean;
}

export const DEFAULT_SETTINGS: ScalosaurusSettings = {
	snapEnabled: true,
	snapInThreshold: 12,
	snapOutThreshold: 20,
	sentinelMode: "percent",
	unlockModifier: "shift",
	minWidth: 32,
	readingModeEnabled: true,
	suppressNative: true,
};

/** Snap config for the drag reducer, derived from settings. */
export function snapConfigFrom(settings: ScalosaurusSettings): SnapConfig {
	return {
		enabled: settings.snapEnabled,
		inThreshold: settings.snapInThreshold,
		outThreshold: settings.snapOutThreshold,
	};
}

/** Is the aspect-ratio unlock modifier held? Sampled per pointer event. */
export function isUnlockModifierHeld(
	e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
	modifier: UnlockModifier,
): boolean {
	switch (modifier) {
		case "shift":
			return e.shiftKey;
		case "alt":
			return e.altKey;
		case "ctrl":
			return e.ctrlKey;
		case "meta":
			return e.metaKey;
	}
}

/** Structural host interface — avoids a settings.ts ↔ main.ts import cycle. */
export interface SettingsHost extends Plugin {
	settings: ScalosaurusSettings;
	saveSettings(): Promise<void>;
	/** Re-apply anything derived from settings (native suppression class). */
	onSettingsChanged(): void;
}

export class ScalosaurusSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly host: SettingsHost,
	) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.host.settings;

		const save = async () => {
			await this.host.saveSettings();
			this.host.onSettingsChanged();
		};

		new Setting(containerEl)
			.setName("Snap to column width")
			.setDesc(
				"While dragging, snap to the width of the surrounding text column and show a guide line.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.snapEnabled).onChange(async (value) => {
					settings.snapEnabled = value;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Snapped size format")
			.setDesc(
				"What a snapped resize writes into the link. The responsive tokens keep the image at full column width when the window or theme changes, but need this plugin to render — and caption plugins may display them as a caption. Fixed pixels avoids both at the cost of responsiveness.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("percent", "Responsive (|100%)")
					.addOption("fit", "Responsive (|fit)")
					.addOption("px", "Fixed pixels")
					.setValue(settings.sentinelMode)
					.onChange(async (value) => {
						settings.sentinelMode = value as SentinelMode;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Snap-in distance")
			.setDesc("Snap once the dragged width is within this many pixels of the column width.")
			.addSlider((slider) =>
				slider
					.setLimits(4, 32, 1)
					.setValue(settings.snapInThreshold)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.snapInThreshold = value;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Snap-out distance")
			.setDesc(
				"Release the snap only after dragging this many pixels back inside — prevents jitter at the edge.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(8, 48, 1)
					.setValue(settings.snapOutThreshold)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.snapOutThreshold = value;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Aspect-ratio unlock modifier")
			.setDesc(
				"Hold this key while dragging to resize width and height independently (writes |WxH). Sampled continuously, so it can be pressed or released mid-drag.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("shift", "Shift")
					.addOption("alt", "Alt")
					.addOption("ctrl", "Ctrl")
					.addOption("meta", "Meta")
					.setValue(settings.unlockModifier)
					.onChange(async (value) => {
						settings.unlockModifier = value as UnlockModifier;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum width")
			.setDesc("Images cannot be dragged narrower than this many pixels.")
			.addSlider((slider) =>
				slider
					.setLimits(16, 128, 1)
					.setValue(settings.minWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.minWidth = value;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Resize in reading view")
			.setDesc("Show resize handles in reading view as well, not only in Live Preview.")
			.addToggle((toggle) =>
				toggle.setValue(settings.readingModeEnabled).onChange(async (value) => {
					settings.readingModeEnabled = value;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Suppress native resize UI")
			.setDesc(
				"Keep Obsidian's built-in corner-drag (1.12+) from competing with these handles.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.suppressNative).onChange(async (value) => {
					settings.suppressNative = value;
					await save();
				}),
			);
	}
}
