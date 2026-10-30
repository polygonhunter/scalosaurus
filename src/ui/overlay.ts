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
 *   pointermove  → only records the latest pointer input; one rAF per
 *                  frame then runs reducer → inline img styles → ONE
 *                  layout read → overlay writes (no forced reflow per
 *                  event, and CM6 geometry updates share the same frame)
 *   pointerup    → apply the release position and modifier state, map the
 *                  final state to a SizeSpec → callbacks.onCommit(...)
 *                  (inline styles are intentionally KEPT: in Live Preview
 *                  the old widget DOM dies on the rewrite anyway; in
 *                  Reading Mode they prevent a visible snap-back until the
 *                  block re-renders)
 *   Escape / pointercancel / lost capture → restore inline styles, no write
 *   click without movement (< 3px) → no write
 *   double-click on a handle → callbacks.onReset() (remove the size param)
 *   touch long-press without movement → callbacks.onContextMenu() (size
 *                  menu; iOS fires no `contextmenu` on long-press)
 */

import { Notice, Platform } from "obsidian";
import { measureContainingBlock, type ColumnMetrics } from "../core/column";
import type { SizeSpec } from "../core/parse";
import {
	commitSize,
	initialDragState,
	readoutLabel,
	reduceDrag,
	resolveAspectRatio,
	type DragConfig,
	type DragInput,
	type DragState,
	type SentinelMode,
	type SnapConfig,
} from "../core/session";
import { isUnlockModifierHeld, type UnlockModifier } from "../core/settings-model";

export interface OverlayOptions {
	minWidth: number;
	snap: SnapConfig;
	sentinelMode: SentinelMode;
	unlockModifier: UnlockModifier;
}
// (Built from settings by overlayOptionsFrom in core/settings-model.)

export interface OverlayCallbacks {
	/** Fail-fast target resolution at pointerdown. False aborts the drag. */
	onDragStart(): boolean;
	/**
	 * Final size on pointerup (already mapped: sentinel / W / WxH).
	 * Returns whether the document was actually written — on false the
	 * overlay restores the pre-drag inline styles, so the image never shows
	 * a size that is not in the document (aborted or no-op commits).
	 */
	onCommit(size: SizeSpec): boolean | Promise<boolean>;
	/** Double-click on a handle: remove the size param entirely. */
	onReset(): void;
	/** The image left the DOM (widget recycled) — owner should clear us. */
	onDetached(): void;
	/** Right-click / long-press on a handle: size presets menu. */
	onContextMenu(e: MouseEvent): void;
}

/** Platform-correct key name for the unlock modifier (handle labels). */
function modifierLabel(modifier: UnlockModifier): string {
	switch (modifier) {
		case "shift":
			return "Shift";
		case "alt":
			return Platform.isMacOS ? "Option" : "Alt";
		case "ctrl":
			return "Ctrl";
		case "meta":
			return Platform.isMacOS ? "Cmd" : "Meta";
	}
}

const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];

const CLICK_TOLERANCE_PX = 3;
const LONG_PRESS_MS = 500;
export const CANNOT_RESIZE_NOTICE = "Scalosaurus: this image can't be resized here.";
/** Body class per corner: keeps the resize cursor for the whole drag. */
const CURSOR_CLASSES: Record<Corner, string> = {
	nw: "scalosaurus-resize-nwse",
	se: "scalosaurus-resize-nwse",
	ne: "scalosaurus-resize-nesw",
	sw: "scalosaurus-resize-nesw",
};
const GUIDE_OVERSHOOT_PX = 16;
/** Half of the 28px handle hit target (styles.css .scalosaurus-handle). */
const HANDLE_HIT_HALF_PX = 14;

interface ActiveDrag {
	corner: Corner;
	pointerId: number;
	startX: number;
	startY: number;
	/** Latest pointer position (re-applied when only a modifier changes). */
	lastX: number;
	lastY: number;
	cfg: DragConfig;
	state: DragState;
	column: ColumnMetrics | null;
	moved: boolean;
	unlocked: boolean;
	/** Latest pointer input not yet applied (coalesced to one per frame). */
	pendingInput: DragInput | null;
	/** Pending touch long-press timer (0 = none). */
	longPressTimer: number;
	previousInlineWidth: string;
	previousInlineHeight: string;
	previousInlineMaxWidth: string;
}

export class ResizeOverlay {
	private readonly doc: Document;
	private readonly win: Window;
	private readonly root: HTMLElement;
	private readonly frame: HTMLElement;
	private readonly guide: HTMLElement;
	private readonly readout: HTMLElement;
	private readonly handles = new Map<Corner, HTMLElement>();

	/** Scroll container the overlay is clipped to (pane content area). */
	private readonly clipEl: HTMLElement | null;

	private drag: ActiveDrag | null = null;
	private rafId = 0;
	private fadeRafId = 0;
	private destroyed = false;
	/** A long-press opened the menu: swallow the native `contextmenu` that may follow. */
	private longPressOpened = false;

	private readonly domCleanups: Array<() => void> = [];
	private dragCleanups: Array<() => void> = [];

	constructor(
		private readonly embedEl: HTMLElement,
		private readonly visual: HTMLElement,
		private readonly options: OverlayOptions,
		private readonly callbacks: OverlayCallbacks,
	) {
		this.doc = embedEl.ownerDocument;
		this.win = this.doc.defaultView ?? activeWindow;

		// body.createDiv creates the element in the body's own document, so
		// the overlay stays correct inside pop-out windows.
		this.root = this.doc.body.createDiv({ cls: "scalosaurus-overlay" });
		this.frame = this.child("scalosaurus-frame");
		this.guide = this.child("scalosaurus-guide");
		this.readout = this.child("scalosaurus-readout");
		this.clipEl = embedEl.closest<HTMLElement>(".cm-scroller, .markdown-preview-view");
		const handleLabel = Platform.isMobile
			? "Drag to resize · Long-press: sizes"
			: `Drag to resize · ${modifierLabel(options.unlockModifier)}: free ratio · Double-click: reset · Right-click: sizes`;
		for (const corner of CORNERS) {
			const handle = this.child("scalosaurus-handle");
			handle.dataset.corner = corner;
			handle.setAttribute("aria-label", handleLabel);
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
			this.listen(handle, "contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (this.longPressOpened) {
					// Our long-press timer already opened the menu.
					this.longPressOpened = false;
					return;
				}
				// Touch long-press starts a drag first (pointerdown) — a
				// press that has not moved is a menu request, not a resize.
				if (this.drag) {
					if (this.drag.moved) return;
					this.cancelDrag();
				}
				this.callbacks.onContextMenu(e as MouseEvent);
			});
		}
		// Keep the overlay glued to the image while scrolling/resizing.
		this.listen(this.doc, "scroll", () => this.scheduleReposition(), {
			capture: true,
			passive: true,
		});
		this.listen(this.win, "resize", () => this.scheduleReposition());
		// The owner calls reposition() once it holds the reference, so an
		// immediate onDetached() can tear this overlay down properly.

		// Fade in on the next frame (CSS transition with a short delay, so
		// merely sweeping the pointer across images does not flash frames).
		this.fadeRafId = this.win.requestAnimationFrame(() => {
			this.fadeRafId = 0;
			this.root.classList.add("is-visible");
		});
	}

	private child(className: string): HTMLElement {
		return this.root.createDiv({ cls: className });
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

	/** Stale-overlay guard for the owner: is the visual still in the DOM? */
	get visualConnected(): boolean {
		return this.visual.isConnected;
	}

	/** Is this node part of the overlay? (Owner keeps us alive on hover.) */
	contains(node: Node): boolean {
		return this.root.contains(node);
	}

	/**
	 * One rAF per frame, shared by scroll/resize/CM6-geometry repositioning
	 * and the drag: while dragging, the frame first applies the latest
	 * pointer input, then measures once.
	 */
	scheduleReposition(): void {
		if (this.rafId !== 0 || this.destroyed) return;
		this.rafId = this.win.requestAnimationFrame(() => {
			this.rafId = 0;
			if (this.flushPendingInput()) this.reposition();
		});
	}

	private cancelFrame(): void {
		if (this.rafId !== 0) {
			this.win.cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
	}

	/**
	 * Apply the coalesced pointer input: reducer + style WRITES only (no
	 * layout reads here). Returns false when the drag had to be aborted
	 * because the visual left the DOM (cancelDrag already repositioned).
	 */
	private flushPendingInput(): boolean {
		const drag = this.drag;
		if (!drag || !drag.pendingInput) return true;
		const input = drag.pendingInput;
		drag.pendingInput = null;
		if (!this.visual.isConnected) {
			// Widget was recreated under us (external edit) — abort cleanly.
			this.cancelDrag();
			return false;
		}
		drag.state = reduceDrag(drag.cfg, drag.state, input);
		this.visual.style.width = `${drag.state.width}px`;
		this.visual.style.height = `${drag.state.height}px`;
		// Excalidraw's native-SVG preview sizes via max-width — without this
		// override the drag preview would be clamped by the old size.
		this.visual.style.maxWidth = `${drag.state.width}px`;
		return true;
	}

	reposition(): void {
		if (this.destroyed) return;
		if (!this.visual.isConnected) {
			this.callbacks.onDetached();
			return;
		}
		// All layout READS first (visual + clip container), then writes.
		const rect = this.visual.getBoundingClientRect();
		const clip = this.clipEl?.getBoundingClientRect() ?? null;
		// 0×0: the image is hidden (other tab, mode switch, collapsed
		// parent) — handles parked at (0,0) would intercept clicks there.
		if (!(rect.width > 0) || !(rect.height > 0)) {
			this.callbacks.onDetached();
			return;
		}
		const drag = this.drag;

		// Clip to the pane's scroll area: an image scrolled under the tab
		// header must not draw (or catch clicks with) handles on top of it.
		if (clip) {
			const outside =
				rect.bottom <= clip.top ||
				rect.top >= clip.bottom ||
				rect.right <= clip.left ||
				rect.left >= clip.right;
			this.root.classList.toggle("is-offscreen", outside && !drag);
			const vw = this.win.innerWidth;
			const vh = this.win.innerHeight;
			this.root.style.clipPath = `inset(${Math.max(0, clip.top)}px ${Math.max(0, vw - clip.right)}px ${Math.max(0, vh - clip.bottom)}px ${Math.max(0, clip.left)}px)`;
		}
		// Vertically the whole 28px hit target must fit: a handle whose
		// centre is just inside the top/bottom edge would still catch clicks
		// up to 14px over the view header / tab bar (clip-path only hides).
		// Horizontally the centre test stays — the pane's content padding
		// keeps images away from the side edges, and a full-target test
		// there would hide the left handles on narrow (mobile) panes.
		const inClip = (x: number, y: number) =>
			!clip ||
			(x >= clip.left &&
				x <= clip.right &&
				y - HANDLE_HIT_HALF_PX >= clip.top &&
				y + HANDLE_HIT_HALF_PX <= clip.bottom);

		this.place(this.frame, rect.left, rect.top, rect.width, rect.height);
		const corners: Array<[Corner, number, number]> = [
			["nw", rect.left, rect.top],
			["ne", rect.right, rect.top],
			["sw", rect.left, rect.bottom],
			["se", rect.right, rect.bottom],
		];
		for (const [corner, x, y] of corners) {
			this.placeHandle(corner, x, y);
			// clip-path hides but does not stop clicks — hide clipped handles
			// outright. Never the one being dragged (it holds pointer capture).
			const hidden = !inClip(x, y) && drag?.corner !== corner;
			this.handles.get(corner)?.classList.toggle("is-hidden", hidden);
		}

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
			this.readout.textContent = readoutLabel(drag.state, {
				unlocked: drag.unlocked,
				sentinelMode: this.options.sentinelMode,
			});
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
		this.longPressOpened = false;
		if (this.drag || this.destroyed) return;
		if (e.button !== 0) return;
		// Stale or hidden overlay (image re-rendered under us, collapsed,
		// other tab): don't consume the event — let the click land where
		// the user aimed, and disappear.
		if (!this.visual.isConnected) {
			this.callbacks.onDetached();
			return;
		}
		const rect = this.visual.getBoundingClientRect();
		if (!(rect.width > 0) || !(rect.height > 0)) {
			this.callbacks.onDetached();
			return;
		}
		// Blocks Obsidian's native (>= 1.12) corner-drag from also starting
		// (still inside this synchronous handler, so it always wins).
		e.preventDefault();
		e.stopPropagation();
		if (!this.callbacks.onDragStart()) {
			// The note changed since the handles appeared. Say so instead of
			// silently swallowing the press, and drop the dead handles.
			new Notice(CANNOT_RESIZE_NOTICE);
			this.callbacks.onDetached();
			return;
		}
		const column = measureContainingBlock(this.embedEl);
		// Only <img> visuals expose natural dimensions; SVGs (Excalidraw)
		// fall back to the rendered rect inside resolveAspectRatio.
		const natural = this.visual as Partial<HTMLImageElement>;
		const cfg: DragConfig = {
			startWidth: rect.width,
			startHeight: rect.height,
			aspectRatio: resolveAspectRatio(
				natural.naturalWidth ?? 0,
				natural.naturalHeight ?? 0,
				rect.width,
				rect.height,
			),
			minWidth: this.options.minWidth,
			columnWidth: column?.width ?? null,
			snap: this.options.snap,
		};

		const handle = this.handles.get(corner);
		try {
			handle?.setPointerCapture(e.pointerId);
		} catch {
			// The pointer is no longer active (released meanwhile): no drag.
			return;
		}

		const drag: ActiveDrag = {
			corner,
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			lastX: e.clientX,
			lastY: e.clientY,
			cfg,
			state: initialDragState(cfg),
			column,
			moved: false,
			unlocked: isUnlockModifierHeld(e, this.options.unlockModifier),
			pendingInput: null,
			longPressTimer: 0,
			previousInlineWidth: this.visual.style.width,
			previousInlineHeight: this.visual.style.height,
			previousInlineMaxWidth: this.visual.style.maxWidth,
		};
		this.drag = drag;

		if (handle) {
			this.listenDuringDrag(handle, "pointermove", (ev) => this.moveDrag(ev as PointerEvent));
			this.listenDuringDrag(handle, "pointerup", (ev) => this.finishDrag(ev as PointerEvent));
			this.listenDuringDrag(handle, "pointercancel", () => this.cancelDrag());
			// Capture lost without pointerup/pointercancel: never leave a
			// stuck drag behind (global user-select:none, hover disabled).
			this.listenDuringDrag(handle, "lostpointercapture", () => this.cancelDrag());
		}
		const onKey = (ev: Event) => this.onDragKey(ev as KeyboardEvent);
		this.listenDuringDrag(this.win, "keydown", onKey, { capture: true });
		this.listenDuringDrag(this.win, "keyup", onKey, { capture: true });
		if (e.pointerType === "touch") {
			// Long-press = size menu (iOS fires no contextmenu on long-press).
			drag.longPressTimer = window.setTimeout(() => this.openLongPressMenu(drag, e), LONG_PRESS_MS);
		}
		this.doc.body.classList.add("scalosaurus-dragging", CURSOR_CLASSES[corner]);
	}

	private onDragKey(ev: KeyboardEvent): void {
		const drag = this.drag;
		if (!drag) return;
		if (ev.type === "keydown" && ev.key === "Escape") {
			ev.preventDefault();
			ev.stopPropagation();
			this.cancelDrag();
			return;
		}
		// Modifier pressed/released without moving: update the preview.
		if (drag.moved && isUnlockModifierHeld(ev, this.options.unlockModifier) !== drag.unlocked) {
			this.recordInput(drag, drag.lastX, drag.lastY, ev);
			this.scheduleReposition();
		}
	}

	private openLongPressMenu(drag: ActiveDrag, e: PointerEvent): void {
		drag.longPressTimer = 0;
		if (this.drag !== drag || drag.moved) return;
		this.cancelDrag();
		this.longPressOpened = true;
		this.callbacks.onContextMenu(e);
	}

	private clearLongPress(drag: ActiveDrag): void {
		if (drag.longPressTimer !== 0) {
			window.clearTimeout(drag.longPressTimer);
			drag.longPressTimer = 0;
		}
	}

	/**
	 * Pointer moves can arrive several times per frame (high-rate mice,
	 * coalesced touch). Only record the latest input here — no style writes,
	 * no layout reads; the shared rAF applies it once per frame.
	 */
	private moveDrag(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) return;
		this.recordInput(drag, e.clientX, e.clientY, e);
		this.scheduleReposition();
	}

	/** Record pointer position + modifier state as the pending input. */
	private recordInput(
		drag: ActiveDrag,
		x: number,
		y: number,
		modifiers: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
	): void {
		drag.lastX = x;
		drag.lastY = y;
		const rawDx = x - drag.startX;
		const rawDy = y - drag.startY;
		if (!drag.moved && Math.abs(rawDx) + Math.abs(rawDy) > CLICK_TOLERANCE_PX) {
			drag.moved = true;
			// A real drag, not a long-press.
			this.clearLongPress(drag);
		}

		// Sign-adjust so positive deltas always mean "grow".
		const signX = drag.corner.includes("e") ? 1 : -1;
		const signY = drag.corner.includes("s") ? 1 : -1;
		drag.unlocked = isUnlockModifierHeld(modifiers, this.options.unlockModifier);
		drag.pendingInput = {
			dx: rawDx * signX,
			dy: rawDy * signY,
			unlocked: drag.unlocked,
		};
	}

	private finishDrag(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) return;
		// Apply the release position and modifier state synchronously so the
		// commit writes what the pointer and keys actually reached at release,
		// not the state of the last frame.
		this.recordInput(drag, e.clientX, e.clientY, e);
		this.cancelFrame();
		if (!this.flushPendingInput()) return;
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
		// Inline styles stay on when the write succeeds — see the class
		// comment. When nothing was written (abort or no-op), restore them:
		// the image must not show a size that is not in the document.
		const result = this.callbacks.onCommit(size);
		if (result === false) {
			this.restoreInlineStyles(drag);
			this.reposition();
		} else if (typeof (result as Promise<boolean>)?.then === "function") {
			// A failed write (rejection) counts as "not written".
			void (result as Promise<boolean>)
				.catch(() => false)
				.then((wrote) => {
					// Restore even if the overlay was destroyed meanwhile (the
					// pointer moved on while vault.process was pending): the
					// image itself is still on screen and must not keep a size
					// that never reached the document.
					if (!wrote && this.visual.isConnected) {
						this.restoreInlineStyles(drag);
						if (!this.destroyed) this.reposition();
					}
				});
		}
	}

	private cancelDrag(): void {
		const drag = this.drag;
		if (!drag) return;
		this.cancelFrame();
		drag.pendingInput = null;
		this.endDrag();
		this.restoreInlineStyles(drag);
		this.reposition();
	}

	private restoreInlineStyles(drag: ActiveDrag): void {
		this.visual.style.width = drag.previousInlineWidth;
		this.visual.style.height = drag.previousInlineHeight;
		this.visual.style.maxWidth = drag.previousInlineMaxWidth;
	}

	private endDrag(): void {
		const drag = this.drag;
		this.drag = null;
		if (drag) this.clearLongPress(drag);
		for (const cleanup of this.dragCleanups) cleanup();
		this.dragCleanups = [];
		this.doc.body.classList.remove(
			"scalosaurus-dragging",
			"scalosaurus-resize-nwse",
			"scalosaurus-resize-nesw",
		);
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
		this.cancelFrame();
		if (this.fadeRafId !== 0) this.win.cancelAnimationFrame(this.fadeRafId);
		this.root.remove();
	}
}
