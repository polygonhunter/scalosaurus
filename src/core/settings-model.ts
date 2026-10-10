/**
 * Settings model: types, defaults, validation and derived configs. No
 * `obsidian` imports — unit-tested directly.
 */

import type { SentinelMode, SnapConfig } from "./session";

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
	/**
	 * Legacy (<= 0.1.11): never had UI or CSS effect. Kept optional only so
	 * existing data.json files round-trip unchanged; nothing reads it. A
	 * real native-handle suppression waits for docs/findings.md gate 2.
	 */
	suppressNative?: boolean;
}

export const DEFAULT_SETTINGS: ScalosaurusSettings = {
	snapEnabled: true,
	snapInThreshold: 12,
	snapOutThreshold: 20,
	sentinelMode: "percent",
	unlockModifier: "shift",
	minWidth: 32,
	readingModeEnabled: true,
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

/** Slider limits — shared by the settings UI and sanitizeSettings. */
export const SETTING_LIMITS = {
	snapInThreshold: { min: 4, max: 32 },
	snapOutThreshold: { min: 8, max: 48 },
	minWidth: { min: 16, max: 128 },
} as const;

const SENTINEL_MODES: readonly SentinelMode[] = ["percent", "fit", "px"];
const UNLOCK_MODIFIERS: readonly UnlockModifier[] = ["shift", "alt", "ctrl", "meta"];

function pickBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function pickNumber(
	value: unknown,
	limits: { min: number; max: number },
	fallback: number,
): number {
	// Hand-edited data.json may contain strings ("12") — accept numeric ones.
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
	return Math.min(limits.max, Math.max(limits.min, Math.round(n)));
}

/**
 * Turn whatever `loadData()` returned (null, old versions, hand-edited
 * JSON) into valid settings. Unknown enum values fall back to the default —
 * an invalid `sentinelMode` previously produced broken links like
 * `![[a.png|]]`; numbers are clamped to the slider limits.
 */
export function sanitizeSettings(raw: unknown): ScalosaurusSettings {
	const data = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_SETTINGS;
	return {
		snapEnabled: pickBoolean(data.snapEnabled, d.snapEnabled),
		snapInThreshold: pickNumber(data.snapInThreshold, SETTING_LIMITS.snapInThreshold, d.snapInThreshold),
		snapOutThreshold: pickNumber(
			data.snapOutThreshold,
			SETTING_LIMITS.snapOutThreshold,
			d.snapOutThreshold,
		),
		sentinelMode: pickEnum(data.sentinelMode, SENTINEL_MODES, d.sentinelMode),
		unlockModifier: pickEnum(data.unlockModifier, UNLOCK_MODIFIERS, d.unlockModifier),
		minWidth: pickNumber(data.minWidth, SETTING_LIMITS.minWidth, d.minWidth),
		readingModeEnabled: pickBoolean(data.readingModeEnabled, d.readingModeEnabled),
		...(typeof data.suppressNative === "boolean" ? { suppressNative: data.suppressNative } : {}),
	};
}

/** Overlay options derived from settings (shared by LP and Reading Mode). */
export function overlayOptionsFrom(settings: ScalosaurusSettings): {
	minWidth: number;
	snap: SnapConfig;
	sentinelMode: SentinelMode;
	unlockModifier: UnlockModifier;
} {
	return {
		minWidth: settings.minWidth,
		snap: snapConfigFrom(settings),
		sentinelMode: settings.sentinelMode,
		unlockModifier: settings.unlockModifier,
	};
}
