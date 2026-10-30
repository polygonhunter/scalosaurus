/**
 * Pure drag-session logic: geometry, aspect lock, snap-to-column with
 * hysteresis, and the mapping from a finished drag to the size spec that
 * gets written into the wikilink. No DOM, no `obsidian` imports —
 * unit-tested directly.
 */

import type { SentinelToken, SizeSpec } from "./parse";

export interface SnapConfig {
	enabled: boolean;
	/** Snap in when the proposed width is within this many px of the column. */
	inThreshold: number;
	/** Snap out only once the proposed width moves this far back inside. */
	outThreshold: number;
}

export interface DragConfig {
	startWidth: number;
	startHeight: number;
	/** width / height, guaranteed > 0 (see resolveAspectRatio). */
	aspectRatio: number;
	minWidth: number;
	/** Available width of the embed's containing block; also the max clamp. */
	columnWidth: number | null;
	snap: SnapConfig;
}

export interface DragInput {
	/** Pointer delta, sign-adjusted so positive always means "grow". */
	dx: number;
	dy: number;
	/** Aspect-ratio unlock modifier held during this move. */
	unlocked: boolean;
}

export interface DragState {
	width: number;
	height: number;
	snapped: boolean;
}

const MIN_HEIGHT = 16;

/**
 * Aspect ratio with the SVG/no-intrinsic-size guard: fall back to the
 * rendered rect when natural dimensions are unavailable (0), and to 1 when
 * everything degenerates.
 */
export function resolveAspectRatio(
	naturalWidth: number,
	naturalHeight: number,
	rectWidth: number,
	rectHeight: number,
): number {
	if (naturalWidth > 0 && naturalHeight > 0) return naturalWidth / naturalHeight;
	if (rectWidth > 0 && rectHeight > 0) return rectWidth / rectHeight;
	return 1;
}

export function initialDragState(cfg: DragConfig): DragState {
	return {
		width: Math.round(cfg.startWidth),
		height: Math.round(cfg.startHeight),
		snapped: false,
	};
}

function clampWidth(cfg: DragConfig, width: number): number {
	let w = Math.max(cfg.minWidth, width);
	if (cfg.columnWidth !== null) w = Math.min(w, cfg.columnWidth);
	return w;
}

/**
 * One pointermove step. Aspect-locked by default; `unlocked` resizes both
 * axes freely (and disables snapping — the sentinel implies `height: auto`).
 *
 * Snap hysteresis is asymmetric on purpose: since the column width is also
 * the max clamp, dragging outward past the edge keeps the snap; only pulling
 * clearly back inside (beyond `outThreshold`) releases it. This avoids
 * jitter at the boundary.
 */
export function reduceDrag(cfg: DragConfig, prev: DragState, input: DragInput): DragState {
	if (input.unlocked) {
		const width = Math.round(clampWidth(cfg, cfg.startWidth + input.dx));
		const height = Math.round(Math.max(MIN_HEIGHT, cfg.startHeight + input.dy));
		return { width, height, snapped: false };
	}

	// Aspect-locked: the dominant axis drives the size, so a mostly
	// vertical drag (natural for portrait images) resizes too. A vertical
	// delta is converted to the width change it implies.
	const dyAsWidth = input.dy * cfg.aspectRatio;
	const proposedW =
		cfg.startWidth + (Math.abs(input.dx) >= Math.abs(dyAsWidth) ? input.dx : dyAsWidth);

	let snapped = prev.snapped;
	const col = cfg.columnWidth;
	if (cfg.snap.enabled && col !== null) {
		// The settings UI allows out < in; clamp so the snap-in and snap-out
		// zones can never overlap (which would oscillate every pointermove).
		const outThreshold = Math.max(cfg.snap.outThreshold, cfg.snap.inThreshold);
		if (snapped) {
			if (proposedW < col - outThreshold) snapped = false;
		} else {
			if (proposedW >= col - cfg.snap.inThreshold) snapped = true;
		}
	} else {
		snapped = false;
	}

	const width = Math.round(snapped && col !== null ? col : clampWidth(cfg, proposedW));
	const height = Math.round(Math.max(MIN_HEIGHT, width / cfg.aspectRatio));
	return { width, height, snapped };
}

export type SentinelMode = "percent" | "fit" | "px";

const SENTINEL_BY_MODE: Record<Exclude<SentinelMode, "px">, SentinelToken> = {
	percent: "100%",
	fit: "fit",
};

/**
 * Effective sentinel mode for an embed kind. Excalidraw parses `|100%`
 * natively (its dimension regex accepts percentages), but would misread
 * the non-numeric `|fit` as an image style class — map it to `percent`.
 */
export function sentinelModeFor(mode: SentinelMode, kind: "image" | "excalidraw"): SentinelMode {
	return kind === "excalidraw" && mode === "fit" ? "percent" : mode;
}

export interface CommitOptions {
	/** Modifier state at release time. */
	unlocked: boolean;
	sentinelMode: SentinelMode;
}

/**
 * Map the final drag state to the size spec written into the wikilink:
 * snapped → sentinel (or measured px when the user opted out because of
 * caption-plugin conflicts), unlocked → `WxH`, locked → `W`.
 */
export function commitSize(state: DragState, opts: CommitOptions): SizeSpec {
	if (state.snapped && !opts.unlocked) {
		if (opts.sentinelMode === "px") {
			return { kind: "width", width: state.width };
		}
		// `?? "100%"`: never emit an empty segment (`![[a.png|]]`) even if an
		// unknown mode slips past settings validation.
		const token: SentinelToken | undefined = SENTINEL_BY_MODE[opts.sentinelMode];
		return { kind: "sentinel", token: token ?? "100%" };
	}
	if (opts.unlocked) {
		return { kind: "width-height", width: state.width, height: state.height };
	}
	return { kind: "width", width: state.width };
}

/**
 * Drag readout text — shows what a release would actually write:
 * snapped → `100%` / `fit` / `640 px`, aspect-locked → `640`,
 * unlocked → `640 × 480` (so the lock state is visible too).
 */
export function readoutLabel(state: DragState, opts: CommitOptions): string {
	const size = commitSize(state, opts);
	switch (size.kind) {
		case "sentinel":
			return size.token;
		case "width-height":
			return `${size.width} × ${size.height}`;
		case "width":
			return state.snapped && !opts.unlocked ? `${size.width} px` : `${size.width}`;
		case "none":
			return "";
	}
}

export type SizePreset = "fit" | "half" | "third" | "original";

/**
 * Size spec for a context-menu preset. `fit` follows the snapped-size
 * format (sentinel, or measured px when the user opted out of sentinels);
 * fractions are px of the measured column, never below `minWidth`.
 * Returns null when the preset needs a column width that is unknown.
 */
export function presetSize(
	preset: SizePreset,
	columnWidth: number | null,
	opts: { sentinelMode: SentinelMode; minWidth: number },
): SizeSpec | null {
	const col = columnWidth !== null && columnWidth > 0 ? columnWidth : null;
	const px = (fraction: number): SizeSpec | null =>
		col === null
			? null
			: { kind: "width", width: Math.max(opts.minWidth, Math.round(col * fraction)) };
	switch (preset) {
		case "original":
			return { kind: "none" };
		case "fit":
			if (opts.sentinelMode === "px") return px(1);
			return { kind: "sentinel", token: SENTINEL_BY_MODE[opts.sentinelMode] ?? "100%" };
		case "half":
			return px(1 / 2);
		case "third":
			return px(1 / 3);
	}
}

/** Parse a user-typed width ("400", " 400 px "). Null when invalid. */
export function parseWidthInput(raw: string): number | null {
	const m = /^\s*(\d{1,5})\s*(?:px)?\s*$/i.exec(raw);
	if (!m) return null;
	const n = parseInt(m[1] as string, 10);
	return n >= 1 ? n : null;
}
