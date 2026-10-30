import { describe, expect, it } from "vitest";
import type { DragConfig, DragState } from "../src/core/session";
import {
	commitSize,
	initialDragState,
	readoutLabel,
	parseWidthInput,
	presetSize,
	reduceDrag,
	resolveAspectRatio,
	sentinelModeFor,
} from "../src/core/session";

const cfg = (overrides: Partial<DragConfig> = {}): DragConfig => ({
	startWidth: 400,
	startHeight: 200,
	aspectRatio: 2,
	minWidth: 32,
	columnWidth: 700,
	snap: { enabled: true, inThreshold: 12, outThreshold: 20 },
	...overrides,
});

const step = (c: DragConfig, prev: DragState, dx: number, dy = 0, unlocked = false) =>
	reduceDrag(c, prev, { dx, dy, unlocked });

describe("resolveAspectRatio", () => {
	it("prefers natural dimensions", () => {
		expect(resolveAspectRatio(400, 200, 100, 100)).toBe(2);
	});

	it("falls back to the rendered rect for SVGs without intrinsic size", () => {
		expect(resolveAspectRatio(0, 0, 300, 150)).toBe(2);
	});

	it("degenerates to 1, never NaN", () => {
		expect(resolveAspectRatio(0, 0, 0, 0)).toBe(1);
	});
});

describe("reduceDrag — locked", () => {
	it("scales proportionally", () => {
		const c = cfg();
		const s = step(c, initialDragState(c), 100);
		expect(s).toEqual({ width: 500, height: 250, snapped: false });
	});

	it("clamps to min width", () => {
		const c = cfg();
		const s = step(c, initialDragState(c), -1000);
		expect(s.width).toBe(32);
		expect(s.height).toBe(16);
	});

	it("clamps to the column width", () => {
		const c = cfg({ snap: { enabled: false, inThreshold: 12, outThreshold: 20 } });
		const s = step(c, initialDragState(c), 5000);
		expect(s.width).toBe(700);
		expect(s.snapped).toBe(false);
	});
});

describe("reduceDrag — locked, dominant axis", () => {
	it("resizes on a purely vertical drag (dy converted via the aspect ratio)", () => {
		const c = cfg();
		// dy 50 at aspect 2 → +100 width
		expect(step(c, initialDragState(c), 0, 50)).toEqual({ width: 500, height: 250, snapped: false });
		expect(step(c, initialDragState(c), 0, -50)).toEqual({ width: 300, height: 150, snapped: false });
	});

	it("lets the larger of dx and dy·ratio win", () => {
		const c = cfg();
		// dx 30 vs dy 20·2 = 40 → vertical wins
		expect(step(c, initialDragState(c), 30, 20).width).toBe(440);
		// dx -60 vs dy 10·2 = 20 → horizontal wins (shrinking still works)
		expect(step(c, initialDragState(c), -60, 10).width).toBe(340);
	});
});

describe("sentinelModeFor", () => {
	it("maps fit to percent for Excalidraw only", () => {
		expect(sentinelModeFor("fit", "excalidraw")).toBe("percent");
		expect(sentinelModeFor("fit", "image")).toBe("fit");
		expect(sentinelModeFor("px", "excalidraw")).toBe("px");
		expect(sentinelModeFor("percent", "image")).toBe("percent");
	});
});

describe("reduceDrag — snap hysteresis", () => {
	it("snaps in within the in-threshold", () => {
		const c = cfg();
		// proposed = 400 + 289 = 689, col - in = 688 → snap
		const s = step(c, initialDragState(c), 289);
		expect(s).toEqual({ width: 700, height: 350, snapped: true });
	});

	it("does not snap just outside the in-threshold", () => {
		const c = cfg();
		// proposed = 687 < 688 → no snap
		const s = step(c, initialDragState(c), 287);
		expect(s).toEqual({ width: 687, height: 344, snapped: false });
	});

	it("stays snapped inside the out-threshold (no jitter)", () => {
		const c = cfg();
		let s = step(c, initialDragState(c), 289); // snapped at 700
		// proposed = 681 > col - out = 680 → still snapped
		s = step(c, s, 281);
		expect(s.snapped).toBe(true);
		expect(s.width).toBe(700);
	});

	it("releases the snap past the out-threshold", () => {
		const c = cfg();
		let s = step(c, initialDragState(c), 289);
		// proposed = 679 < 680 → released
		s = step(c, s, 279);
		expect(s.snapped).toBe(false);
		expect(s.width).toBe(679);
	});

	it("stays snapped when dragging outward past the column edge", () => {
		const c = cfg();
		let s = step(c, initialDragState(c), 289);
		s = step(c, s, 2000);
		expect(s.snapped).toBe(true);
		expect(s.width).toBe(700);
	});

	it("does not oscillate when out-threshold < in-threshold (clamped)", () => {
		const c = cfg({ snap: { enabled: true, inThreshold: 32, outThreshold: 8 } });
		let s = step(c, initialDragState(c), 270); // proposed 670 >= 668 → snap
		expect(s.snapped).toBe(true);
		s = step(c, s, 275); // proposed 675, inside in-zone → must STAY snapped
		expect(s.snapped).toBe(true);
		s = step(c, s, 267); // proposed 667 < 700-33? no: 667 < 668 → released
		expect(s.snapped).toBe(false);
	});

	it("never snaps when disabled or without a column", () => {
		const off = cfg({ snap: { enabled: false, inThreshold: 12, outThreshold: 20 } });
		expect(step(off, initialDragState(off), 295).snapped).toBe(false);

		const noCol = cfg({ columnWidth: null });
		const s = step(noCol, initialDragState(noCol), 295);
		expect(s.snapped).toBe(false);
		expect(s.width).toBe(695); // no column → no max clamp either
	});
});

describe("reduceDrag — unlocked", () => {
	it("resizes both axes freely and never snaps", () => {
		const c = cfg();
		const s = step(c, initialDragState(c), 295, 40, true);
		expect(s).toEqual({ width: 695, height: 240, snapped: false });
	});

	it("re-locking mid-drag re-applies the aspect ratio", () => {
		const c = cfg();
		// dx dominates (dy·ratio = 80 < 100), so the locked width is 500.
		let s = step(c, initialDragState(c), 100, 40, true);
		expect(s.height).toBe(240);
		s = step(c, s, 100, 40, false);
		expect(s).toEqual({ width: 500, height: 250, snapped: false });
	});
});

describe("commitSize", () => {
	const snapped: DragState = { width: 700, height: 350, snapped: true };
	const free: DragState = { width: 500, height: 250, snapped: false };

	it("snapped → sentinel by mode", () => {
		expect(commitSize(snapped, { unlocked: false, sentinelMode: "percent" })).toEqual({
			kind: "sentinel",
			token: "100%",
		});
		expect(commitSize(snapped, { unlocked: false, sentinelMode: "fit" })).toEqual({
			kind: "sentinel",
			token: "fit",
		});
	});

	it("snapped with px opt-out → measured width", () => {
		expect(commitSize(snapped, { unlocked: false, sentinelMode: "px" })).toEqual({
			kind: "width",
			width: 700,
		});
	});

	it("locked → width only (Obsidian scales the height)", () => {
		expect(commitSize(free, { unlocked: false, sentinelMode: "percent" })).toEqual({
			kind: "width",
			width: 500,
		});
	});

	it("unlocked → WxH", () => {
		expect(commitSize(free, { unlocked: true, sentinelMode: "percent" })).toEqual({
			kind: "width-height",
			width: 500,
			height: 250,
		});
	});
});

describe("readoutLabel", () => {
	const state = (width: number, height: number, snapped: boolean) => ({ width, height, snapped });

	it("shows the sentinel that will be written when snapped", () => {
		expect(readoutLabel(state(640, 480, true), { unlocked: false, sentinelMode: "percent" })).toBe("100%");
		expect(readoutLabel(state(640, 480, true), { unlocked: false, sentinelMode: "fit" })).toBe("fit");
		expect(readoutLabel(state(640, 480, true), { unlocked: false, sentinelMode: "px" })).toBe("640 px");
	});

	it("shows only the width when aspect-locked, W × H when unlocked", () => {
		expect(readoutLabel(state(300, 200, false), { unlocked: false, sentinelMode: "percent" })).toBe("300");
		expect(readoutLabel(state(300, 200, false), { unlocked: true, sentinelMode: "percent" })).toBe("300 × 200");
	});
});

describe("presetSize", () => {
	const opts = { sentinelMode: "percent" as const, minWidth: 32 };

	it("fit writes the configured sentinel, or measured px in px mode", () => {
		expect(presetSize("fit", 700, opts)).toEqual({ kind: "sentinel", token: "100%" });
		expect(presetSize("fit", 700, { ...opts, sentinelMode: "fit" })).toEqual({
			kind: "sentinel",
			token: "fit",
		});
		expect(presetSize("fit", 700.4, { ...opts, sentinelMode: "px" })).toEqual({
			kind: "width",
			width: 700,
		});
	});

	it("fractions are px of the column, floored at minWidth", () => {
		expect(presetSize("half", 700, opts)).toEqual({ kind: "width", width: 350 });
		expect(presetSize("third", 700, opts)).toEqual({ kind: "width", width: 233 });
		expect(presetSize("third", 60, opts)).toEqual({ kind: "width", width: 32 });
	});

	it("original removes the size", () => {
		expect(presetSize("original", null, opts)).toEqual({ kind: "none" });
	});

	it("returns null for column-based presets without a column", () => {
		expect(presetSize("half", null, opts)).toBeNull();
		expect(presetSize("fit", null, { ...opts, sentinelMode: "px" })).toBeNull();
		expect(presetSize("fit", null, opts)).toEqual({ kind: "sentinel", token: "100%" });
	});
});

describe("parseWidthInput", () => {
	it("accepts plain and px-suffixed integers", () => {
		expect(parseWidthInput("400")).toBe(400);
		expect(parseWidthInput(" 400 px ")).toBe(400);
		expect(parseWidthInput("250PX")).toBe(250);
	});

	it("rejects everything else", () => {
		for (const bad of ["", "0", "-5", "4.5", "abc", "50%", "123456"]) {
			expect(parseWidthInput(bad)).toBeNull();
		}
	});
});
