import { describe, expect, it } from "vitest";
import { commitSize, type SentinelMode } from "../src/core/session";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/core/settings-model";

describe("sanitizeSettings", () => {
	it("returns the defaults for null / non-objects", () => {
		expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(sanitizeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
		expect(sanitizeSettings([])).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps valid values", () => {
		const valid = {
			snapEnabled: false,
			snapInThreshold: 10,
			snapOutThreshold: 30,
			sentinelMode: "px",
			unlockModifier: "alt",
			minWidth: 64,
			readingModeEnabled: false,
			suppressNative: false,
		};
		expect(sanitizeSettings(valid)).toEqual(valid);
	});

	it("rejects unknown enum values", () => {
		const s = sanitizeSettings({ sentinelMode: "50%", unlockModifier: "hyper" });
		expect(s.sentinelMode).toBe(DEFAULT_SETTINGS.sentinelMode);
		expect(s.unlockModifier).toBe(DEFAULT_SETTINGS.unlockModifier);
	});

	it("clamps and rounds numbers to the slider limits", () => {
		const s = sanitizeSettings({ snapInThreshold: 1000, snapOutThreshold: -5, minWidth: 40.6 });
		expect(s.snapInThreshold).toBe(32);
		expect(s.snapOutThreshold).toBe(8);
		expect(s.minWidth).toBe(41);
	});

	it("falls back on non-finite or non-numeric numbers, accepts numeric strings", () => {
		const s = sanitizeSettings({ snapInThreshold: NaN, snapOutThreshold: "abc", minWidth: "48" });
		expect(s.snapInThreshold).toBe(DEFAULT_SETTINGS.snapInThreshold);
		expect(s.snapOutThreshold).toBe(DEFAULT_SETTINGS.snapOutThreshold);
		expect(s.minWidth).toBe(48);
	});

	it("only accepts real booleans", () => {
		const s = sanitizeSettings({ snapEnabled: "false", readingModeEnabled: 0 });
		expect(s.snapEnabled).toBe(DEFAULT_SETTINGS.snapEnabled);
		expect(s.readingModeEnabled).toBe(DEFAULT_SETTINGS.readingModeEnabled);
	});

	it("keeps the legacy suppressNative flag only when present", () => {
		expect(sanitizeSettings({})).not.toHaveProperty("suppressNative");
		expect(sanitizeSettings({ suppressNative: true }).suppressNative).toBe(true);
		expect(sanitizeSettings({ suppressNative: "yes" })).not.toHaveProperty("suppressNative");
	});

	it("drops unknown keys", () => {
		expect(sanitizeSettings({ foo: 1 })).not.toHaveProperty("foo");
	});
});

describe("commitSize sentinel fallback", () => {
	it("never emits an empty sentinel for an unknown mode", () => {
		const size = commitSize(
			{ width: 500, height: 300, snapped: true },
			{ unlocked: false, sentinelMode: "bogus" as SentinelMode },
		);
		expect(size).toEqual({ kind: "sentinel", token: "100%" });
	});
});
