import {
	PluginSettingTab,
	Setting,
	type App,
	type Plugin,
	type SettingDefinitionItem,
} from "obsidian";
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

	// Declarative definitions (Obsidian 1.13+): the app renders these and
	// indexes them for the global settings search. display() below renders
	// the same definitions imperatively as the pre-1.13 fallback.
	//
	// Note: `suppressNative` deliberately has no UI yet. The body class
	// it toggles has no CSS rule until the native handle's selector is
	// pinned (docs/findings.md, gate 2) — a visible toggle would be a
	// no-op. Our handles already take precedence via stopPropagation.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Snap to column width",
				desc: "While dragging, snap to the width of the surrounding text column and show a guide line.",
				control: {
					type: "toggle",
					key: "snapEnabled",
					defaultValue: DEFAULT_SETTINGS.snapEnabled,
				},
			},
			{
				name: "Snapped size format",
				desc: "What a snapped resize writes into the link. The responsive tokens keep the image at full column width when the window or theme changes, but need this plugin to render — and caption plugins may display them as a caption. Fixed pixels avoids both at the cost of responsiveness.",
				control: {
					type: "dropdown",
					key: "sentinelMode",
					options: {
						percent: "Responsive (|100%)",
						fit: "Responsive (|fit)",
						px: "Fixed pixels",
					},
					defaultValue: DEFAULT_SETTINGS.sentinelMode,
				},
			},
			{
				name: "Snap-in distance",
				desc: "Snap once the dragged width is within this many pixels of the column width.",
				control: {
					type: "slider",
					key: "snapInThreshold",
					min: 4,
					max: 32,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.snapInThreshold,
				},
			},
			{
				name: "Snap-out distance",
				desc: "Release the snap only after dragging this many pixels back inside — prevents jitter at the edge.",
				control: {
					type: "slider",
					key: "snapOutThreshold",
					min: 8,
					max: 48,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.snapOutThreshold,
				},
			},
			{
				name: "Aspect-ratio unlock modifier",
				desc: "Hold this key while dragging to resize width and height independently (writes |WxH). Sampled continuously, so it can be pressed or released mid-drag.",
				control: {
					type: "dropdown",
					key: "unlockModifier",
					options: { shift: "Shift", alt: "Alt", ctrl: "Ctrl", meta: "Meta" },
					defaultValue: DEFAULT_SETTINGS.unlockModifier,
				},
			},
			{
				name: "Minimum width",
				desc: "Images cannot be dragged narrower than this many pixels.",
				control: {
					type: "slider",
					key: "minWidth",
					min: 16,
					max: 128,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.minWidth,
				},
			},
			{
				name: "Resize in reading view",
				desc: "Show resize handles in reading view as well, not only in Live Preview.",
				control: {
					type: "toggle",
					key: "readingModeEnabled",
					defaultValue: DEFAULT_SETTINGS.readingModeEnabled,
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.host.settings[key as keyof ScalosaurusSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		Object.assign(this.host.settings, { [key]: value });
		await this.host.saveSettings();
		this.host.onSettingsChanged();
	}

	// Imperative fallback for Obsidian < 1.13.0 (minAppVersion allows 1.12.4);
	// 1.13+ bypasses this in favour of getSettingDefinitions().
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		for (const def of this.getSettingDefinitions()) {
			if (!("control" in def) || def.control === undefined) continue;
			const control = def.control;
			const setting = new Setting(containerEl).setName(def.name);
			if (typeof def.desc === "string") setting.setDesc(def.desc);
			const commit = (value: unknown) => {
				void this.setControlValue(control.key, value);
			};
			switch (control.type) {
				case "toggle":
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.getControlValue(control.key) as boolean)
							.onChange(commit),
					);
					break;
				case "dropdown":
					setting.addDropdown((dropdown) =>
						dropdown
							.addOptions(control.options)
							.setValue(this.getControlValue(control.key) as string)
							.onChange(commit),
					);
					break;
				case "slider":
					setting.addSlider((slider) =>
						slider
							.setLimits(control.min, control.max, control.step)
							.setValue(this.getControlValue(control.key) as number)
							.onChange(commit),
					);
					break;
			}
		}
	}
}
