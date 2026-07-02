import { describe, expect, it } from "vitest";
import type { DragConfig, DragState } from "../src/core/session";
import {
	commitSize,
	initialDragState,
	reduceDrag,
	resolveAspectRatio,
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
		let s = step(c, initialDragState(c), 100, 300, true);
		expect(s.height).toBe(500);
		s = step(c, s, 100, 300, false);
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
