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
