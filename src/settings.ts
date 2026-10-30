import {
	PluginSettingTab,
	Setting,
	type App,
	type Plugin,
	type SettingDefinitionItem,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	sanitizeSettings,
	SETTING_LIMITS,
	type ScalosaurusSettings,
} from "./core/settings-model";

export {
	DEFAULT_SETTINGS,
	isUnlockModifierHeld,
	overlayOptionsFrom,
	sanitizeSettings,
	snapConfigFrom,
	type ScalosaurusSettings,
	type UnlockModifier,
} from "./core/settings-model";

/** Structural host interface — avoids a settings.ts ↔ main.ts import cycle. */
export interface SettingsHost extends Plugin {
	settings: ScalosaurusSettings;
	saveSettings(): Promise<void>;
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
	// Note: there is deliberately no "suppress native resize" option until
	// the native handle's selector is pinned (docs/findings.md, gate 2).
	// Our handles already take precedence via stopPropagation.
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
					min: SETTING_LIMITS.snapInThreshold.min,
					max: SETTING_LIMITS.snapInThreshold.max,
					step: 1,
					displayFormat: (v: number) => `${v} px`,
					defaultValue: DEFAULT_SETTINGS.snapInThreshold,
				},
			},
			{
				name: "Snap-out distance",
				desc: "Release the snap only after dragging this many pixels back inside — prevents jitter at the edge.",
				control: {
					type: "slider",
					key: "snapOutThreshold",
					min: SETTING_LIMITS.snapOutThreshold.min,
					max: SETTING_LIMITS.snapOutThreshold.max,
					step: 1,
					displayFormat: (v: number) => `${v} px`,
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
					min: SETTING_LIMITS.minWidth.min,
					max: SETTING_LIMITS.minWidth.max,
					step: 1,
					displayFormat: (v: number) => `${v} px`,
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
		// Validate the merged result: a control can never store a value
		// that would later produce a malformed link.
		const next = sanitizeSettings({ ...this.host.settings, [key]: value });
		Object.assign(this.host.settings, next);
		await this.host.saveSettings();
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
					setting.addSlider((slider) => {
						// 1.12 sliders do not show their value (1.13 renders
						// displayFormat inline) — show it next to the slider.
						const format = control.displayFormat ?? String;
						const valueEl = setting.controlEl.createSpan({
							cls: "scalosaurus-slider-value",
						});
						const showValue = () => valueEl.setText(format(slider.getValue()));
						slider
							.setLimits(control.min, control.max, control.step)
							.setValue(this.getControlValue(control.key) as number)
							.onChange(commit);
						slider.sliderEl.addEventListener("input", showValue);
						showValue();
					});
					break;
			}
		}
	}
}
