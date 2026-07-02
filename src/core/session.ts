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
	const proposedW = cfg.startWidth + input.dx;

	if (input.unlocked) {
		const width = Math.round(clampWidth(cfg, proposedW));
		const height = Math.round(Math.max(MIN_HEIGHT, cfg.startHeight + input.dy));
		return { width, height, snapped: false };
	}

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
		return { kind: "sentinel", token: SENTINEL_BY_MODE[opts.sentinelMode] };
	}
	if (opts.unlocked) {
		return { kind: "width-height", width: state.width, height: state.height };
	}
	return { kind: "width", width: state.width };
}
