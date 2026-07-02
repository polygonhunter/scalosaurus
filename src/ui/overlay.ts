/**
 * Resize overlay: frame, four corner handles, snap guide line and a width
 * readout. Lives OUTSIDE Obsidian's embed widget DOM (CM6 recycles widgets
 * off-viewport and recreates them on every token edit — anything grafted
 * onto them dies), as an absolutely positioned layer on the embed
 * document's body. All elements are created from `embedEl.ownerDocument`
 * and listeners attach to that document/window — popout-safe.
 *
 * Drag protocol (plan invariant: zero document writes mid-drag):
 *   pointerdown  → callbacks.onDragStart() fail-fast; setPointerCapture
 *   pointermove  → pure reducer → inline img styles + guide/readout only
 *   pointerup    → map final state to a SizeSpec → callbacks.onCommit(...)
 *                  (inline styles are intentionally KEPT: in Live Preview
 *                  the old widget DOM dies on the rewrite anyway; in
 *                  Reading Mode they prevent a visible snap-back until the
 *                  block re-renders)
 *   Escape / pointercancel → restore inline styles, no write
 *   click without movement (< 3px) → no write
 *   double-click on a handle → callbacks.onReset() (remove the size param)
 */

import { measureContainingBlock, type ColumnMetrics } from "../core/column";
import type { SizeSpec } from "../core/parse";
import {
	commitSize,
	initialDragState,
	reduceDrag,
	resolveAspectRatio,
	type DragConfig,
	type DragState,
	type SentinelMode,
	type SnapConfig,
} from "../core/session";
import { isUnlockModifierHeld, type UnlockModifier } from "../settings";

export interface OverlayOptions {
	minWidth: number;
	snap: SnapConfig;
	sentinelMode: SentinelMode;
	unlockModifier: UnlockModifier;
}

export interface OverlayCallbacks {
	/** Fail-fast target resolution at pointerdown. False aborts the drag. */
	onDragStart(): boolean;
	/** Final size on pointerup (already mapped: sentinel / W / WxH). */
	onCommit(size: SizeSpec): void;
	/** Double-click on a handle: remove the size param entirely. */
	onReset(): void;
	/** The image left the DOM (widget recycled) — owner should clear us. */
	onDetached(): void;
}

const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];

const CLICK_TOLERANCE_PX = 3;
const GUIDE_OVERSHOOT_PX = 16;

interface ActiveDrag {
	corner: Corner;
	pointerId: number;
	startX: number;
	startY: number;
	cfg: DragConfig;
	state: DragState;
	column: ColumnMetrics | null;
	moved: boolean;
	unlocked: boolean;
	previousInlineWidth: string;
	previousInlineHeight: string;
}

export class ResizeOverlay {
	private readonly doc: Document;
	private readonly win: Window;
	private readonly root: HTMLElement;
	private readonly frame: HTMLElement;
	private readonly guide: HTMLElement;
	private readonly readout: HTMLElement;
	private readonly handles = new Map<Corner, HTMLElement>();

	private drag: ActiveDrag | null = null;
	private rafId = 0;
	private destroyed = false;

	private readonly domCleanups: Array<() => void> = [];
	private dragCleanups: Array<() => void> = [];

	constructor(
		private readonly embedEl: HTMLElement,
		private readonly img: HTMLImageElement,
		private readonly options: OverlayOptions,
		private readonly callbacks: OverlayCallbacks,
	) {
		this.doc = embedEl.ownerDocument;
		this.win = this.doc.defaultView ?? window;

		this.root = this.doc.createElement("div");
		this.root.className = "scalosaurus-overlay";
		this.frame = this.child("scalosaurus-frame");
		this.guide = this.child("scalosaurus-guide");
		this.readout = this.child("scalosaurus-readout");
		for (const corner of CORNERS) {
			const handle = this.child("scalosaurus-handle");
			handle.dataset.corner = corner;
			this.handles.set(corner, handle);
			this.listen(handle, "pointerdown", (e) => this.startDrag(corner, e as PointerEvent));
			this.listen(handle, "click", (e) => {
				e.preventDefault();
				e.stopPropagation();
			});
			this.listen(handle, "dblclick", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.callbacks.onReset();
			});
		}
		this.doc.body.appendChild(this.root);

		// Keep the overlay glued to the image while scrolling/resizing.
		this.listen(this.doc, "scroll", () => this.scheduleReposition(), {
			capture: true,
			passive: true,
		});
		this.listen(this.win, "resize", () => this.scheduleReposition());

		this.reposition();
	}

	private child(className: string): HTMLElement {
		const el = this.doc.createElement("div");
		el.className = className;
		this.root.appendChild(el);
		return el;
	}

	private listen(
		target: EventTarget,
		type: string,
		handler: (e: Event) => void,
		options?: AddEventListenerOptions,
	): void {
		target.addEventListener(type, handler, options);
		this.domCleanups.push(() => target.removeEventListener(type, handler, options));
	}

	private listenDuringDrag(
		target: EventTarget,
		type: string,
		handler: (e: Event) => void,
		options?: AddEventListenerOptions,
	): void {
		target.addEventListener(type, handler, options);
		this.dragCleanups.push(() => target.removeEventListener(type, handler, options));
	}

	get isDragging(): boolean {
		return this.drag !== null;
	}

	/** Is this node part of the overlay? (Owner keeps us alive on hover.) */
	contains(node: Node): boolean {
		return this.root.contains(node);
	}

	/** Does this overlay belong to the given embed element? */
	ownsEmbed(el: Element): boolean {
		return this.embedEl === el;
	}

	scheduleReposition(): void {
		if (this.rafId !== 0 || this.destroyed) return;
		this.rafId = this.win.requestAnimationFrame(() => {
			this.rafId = 0;
			this.reposition();
		});
	}

	reposition(): void {
		if (this.destroyed) return;
		if (!this.img.isConnected) {
			this.callbacks.onDetached();
			return;
		}
		const rect = this.img.getBoundingClientRect();
		this.place(this.frame, rect.left, rect.top, rect.width, rect.height);
		this.placeHandle("nw", rect.left, rect.top);
		this.placeHandle("ne", rect.right, rect.top);
		this.placeHandle("sw", rect.left, rect.bottom);
		this.placeHandle("se", rect.right, rect.bottom);

		const drag = this.drag;
		if (drag) {
			if (drag.column && drag.state.snapped) {
				this.guide.classList.add("is-active");
				this.place(
					this.guide,
					drag.column.right - 1,
					rect.top - GUIDE_OVERSHOOT_PX,
					2,
					rect.height + GUIDE_OVERSHOOT_PX * 2,
				);
			} else {
				this.guide.classList.remove("is-active");
			}
			this.readout.classList.add("is-active");
			this.readout.style.left = `${rect.left + rect.width / 2}px`;
			this.readout.style.top = `${rect.bottom + 8}px`;
			this.readout.textContent = drag.state.snapped
				? "100%"
				: `${drag.state.width} × ${drag.state.height}`;
		} else {
			this.guide.classList.remove("is-active");
			this.readout.classList.remove("is-active");
		}
	}

	private place(el: HTMLElement, left: number, top: number, width: number, height: number): void {
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
		el.style.width = `${width}px`;
		el.style.height = `${height}px`;
	}

	private placeHandle(corner: Corner, x: number, y: number): void {
		const handle = this.handles.get(corner);
		if (!handle) return;
		handle.style.left = `${x}px`;
		handle.style.top = `${y}px`;
	}

	private startDrag(corner: Corner, e: PointerEvent): void {
		if (this.drag || this.destroyed) return;
		if (e.button !== 0) return;
		// Blocks Obsidian's native (>= 1.12) corner-drag from also starting.
		e.preventDefault();
		e.stopPropagation();
		if (!this.img.isConnected || !this.callbacks.onDragStart()) return;

		const rect = this.img.getBoundingClientRect();
		if (!(rect.width > 0) || !(rect.height > 0)) return;
		const column = measureContainingBlock(this.embedEl);
		const cfg: DragConfig = {
			startWidth: rect.width,
			startHeight: rect.height,
			aspectRatio: resolveAspectRatio(
				this.img.naturalWidth,
				this.img.naturalHeight,
				rect.width,
				rect.height,
			),
			minWidth: this.options.minWidth,
			columnWidth: column?.width ?? null,
			snap: this.options.snap,
		};

		this.drag = {
			corner,
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			cfg,
			state: initialDragState(cfg),
			column,
			moved: false,
			unlocked: isUnlockModifierHeld(e, this.options.unlockModifier),
			previousInlineWidth: this.img.style.width,
			previousInlineHeight: this.img.style.height,
		};

		const handle = this.handles.get(corner);
		if (handle) {
			handle.setPointerCapture(e.pointerId);
			this.listenDuringDrag(handle, "pointermove", (ev) => this.moveDrag(ev as PointerEvent));
			this.listenDuringDrag(handle, "pointerup", (ev) => this.finishDrag(ev as PointerEvent));
			this.listenDuringDrag(handle, "pointercancel", () => this.cancelDrag());
		}
		this.listenDuringDrag(
			this.win,
			"keydown",
			(ev) => {
				if ((ev as KeyboardEvent).key === "Escape") {
					ev.preventDefault();
					ev.stopPropagation();
					this.cancelDrag();
				}
			},
			{ capture: true },
		);
		this.doc.body.classList.add("scalosaurus-dragging");
	}

	private moveDrag(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) return;
		if (!this.img.isConnected) {
			// Widget was recreated under us (external edit) — abort cleanly.
			this.cancelDrag();
			return;
		}

		const rawDx = e.clientX - drag.startX;
		const rawDy = e.clientY - drag.startY;
		if (Math.abs(rawDx) + Math.abs(rawDy) > CLICK_TOLERANCE_PX) drag.moved = true;

		// Sign-adjust so positive deltas always mean "grow".
		const signX = drag.corner.includes("e") ? 1 : -1;
		const signY = drag.corner.includes("s") ? 1 : -1;
		drag.unlocked = isUnlockModifierHeld(e, this.options.unlockModifier);
		drag.state = reduceDrag(drag.cfg, drag.state, {
			dx: rawDx * signX,
			dy: rawDy * signY,
			unlocked: drag.unlocked,
		});

		this.img.style.width = `${drag.state.width}px`;
		this.img.style.height = `${drag.state.height}px`;
		this.reposition();
	}

	private finishDrag(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) return;
		this.endDrag();

		if (!drag.moved) {
			// Plain click on a handle: not a resize.
			this.restoreInlineStyles(drag);
			this.reposition();
			return;
		}

		const size = commitSize(drag.state, {
			unlocked: drag.unlocked,
			sentinelMode: this.options.sentinelMode,
		});
		// Inline styles stay on — see the class comment.
		this.callbacks.onCommit(size);
	}

	private cancelDrag(): void {
		const drag = this.drag;
		if (!drag) return;
		this.endDrag();
		this.restoreInlineStyles(drag);
		this.reposition();
	}

	private restoreInlineStyles(drag: ActiveDrag): void {
		this.img.style.width = drag.previousInlineWidth;
		this.img.style.height = drag.previousInlineHeight;
	}

	private endDrag(): void {
		this.drag = null;
		for (const cleanup of this.dragCleanups) cleanup();
		this.dragCleanups = [];
		this.doc.body.classList.remove("scalosaurus-dragging");
		this.guide.classList.remove("is-active");
		this.readout.classList.remove("is-active");
	}

	destroy(): void {
		if (this.destroyed) return;
		// Mid-drag teardown (plugin unload, pane close): behave like Escape.
		if (this.drag) this.cancelDrag();
		this.destroyed = true;
		for (const cleanup of this.domCleanups) cleanup();
		this.domCleanups.length = 0;
		if (this.rafId !== 0) this.win.cancelAnimationFrame(this.rafId);
		this.root.remove();
	}
}
