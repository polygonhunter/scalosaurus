/**
 * Shared hover/tap → overlay lifecycle used by both the Live Preview
 * ViewPlugin and the Reading Mode controller. Listens (delegated) on a
 * Document for pointerover (hover) and pointerdown (tap-to-select — hover
 * does not exist on touch), shows one ResizeOverlay for the embed under the
 * pointer and clears it when the pointer moves elsewhere.
 */

import type { App } from "obsidian";
import { linkTargetKind, type SizeSpec } from "../core/parse";
import { sentinelModeFor } from "../core/session";
import { ResizeOverlay, type OverlayCallbacks, type OverlayOptions } from "./overlay";
import { openSizeMenu } from "./size-menu";

/**
 * What kind of embed the handles are attached to. Excalidraw drawings are
 * markdown files whose embeds render as `.markdown-embed`, but unlike a
 * note transclusion their `![[...]]` token lives in the CURRENT file, so
 * resizing them is safe. Excalidraw parses `|100%` natively, so snapping
 * writes `|100%` for them too; only the `|fit` sentinel is mapped to
 * `|100%` (Excalidraw would misread it as a style class).
 */
export type EmbedKind = "image" | "excalidraw";

export interface EmbedHit {
	embedEl: HTMLElement;
	/** The rendered visual to size: `<img>` for images, svg/img for Excalidraw. */
	visual: HTMLElement;
	kind: EmbedKind;
}

/**
 * Realm-agnostic element check: `instanceof Element` is false across popout
 * windows (fresh copies of all global constructors), so duck-type instead.
 */
function asElement(target: EventTarget | null): Element | null {
	return target && typeof (target as Element).closest === "function"
		? (target as Element)
		: null;
}

/**
 * DOM markers the Excalidraw plugin puts on embedded drawings (verified in
 * its MarkdownPostProcessor: `setImgStyle` always adds
 * "excalidraw-embedded-img"; the container itself is rewritten from
 * markdown-embed to `media-embed image-embed`).
 */
const EXCALIDRAW_MARKER_SELECTOR =
	".excalidraw-embedded-img, .excalidraw-svg, .excalidraw-canvas-immersive";

/**
 * First element matching `selector` that belongs to THIS embed — not to an
 * embed nested inside it (e.g. a drawing or image inside a transcluded
 * note, whose link lives in the other file).
 */
function ownElement(embedEl: HTMLElement, selector: string): Element | null {
	for (const el of Array.from(embedEl.querySelectorAll(selector))) {
		if (el.closest(".internal-embed") === embedEl) return el;
	}
	return null;
}

function isExcalidraw(embedEl: HTMLElement, visual: Element): boolean {
	// Cheapest check first: an attribute read beats a subtree query.
	if (linkTargetKind(embedEl.getAttribute("src") ?? "") === "excalidraw") return true;
	if (visual.matches(EXCALIDRAW_MARKER_SELECTOR)) return true;
	return ownElement(embedEl, EXCALIDRAW_MARKER_SELECTOR) !== null;
}

/**
 * Classify one `.internal-embed` container. Returns null when Scalosaurus
 * must not touch it.
 *
 * Transclusion rule: nothing ABOVE the embed may be a `.markdown-embed` —
 * an enclosing one means the token lives in another file — and nothing
 * from an embed nested INSIDE it counts as its visual or marker. (Excalidraw
 * rewrites its own container from markdown-embed to image-embed, so
 * drawings pass this guard naturally.)
 *
 * Visual rule: images and Excalidraw's PNG/SVGIMG preview modes render an
 * `<img>`; Excalidraw's native-SVG preview mode renders an `<svg>` inside
 * the image-embed container instead — both are resizable.
 */
export function classifyEmbed(embedEl: HTMLElement): EmbedHit | null {
	if (embedEl.parentElement?.closest(".markdown-embed")) return null;
	const isImageEmbed = embedEl.classList.contains("image-embed");

	const img = ownElement(embedEl, "img");
	if (img?.isConnected) {
		const excalidraw = isExcalidraw(embedEl, img);
		if (!isImageEmbed && !excalidraw) return null;
		return { embedEl, visual: img as HTMLElement, kind: excalidraw ? "excalidraw" : "image" };
	}

	const svg = ownElement(embedEl, "svg");
	if (svg?.isConnected && (isImageEmbed || isExcalidraw(embedEl, svg))) {
		return { embedEl, visual: svg as unknown as HTMLElement, kind: "excalidraw" };
	}
	return null;
}

/**
 * Rendered-DOM table signal: is this embed inside a table cell (Reading
 * Mode `td`/`th`, Live Preview table widget)? ORed with the source-line
 * heuristic to decide whether new pipes must be written as `\|`.
 */
export function embedInTable(embedEl: HTMLElement): boolean {
	return embedEl.closest("td, th, .cm-table-widget") !== null;
}

/** All resizable embeds under a root, in DOM order (Reading Mode counting). */
export function collectEligibleEmbeds(root: ParentNode): EmbedHit[] {
	const hits: EmbedHit[] = [];
	for (const el of Array.from(root.querySelectorAll<HTMLElement>(".internal-embed"))) {
		const hit = classifyEmbed(el);
		if (hit) hits.push(hit);
	}
	return hits;
}

export interface HoverAdapter {
	/** For modals opened from the size menu. */
	app: App;
	/** Document to delegate on (per window — popout-safe). */
	doc: Document;
	/** Scope: does this controller own the given embed element? */
	owns(embedEl: HTMLElement): boolean;
	/** Is resizing active for this embed (mode/settings)? */
	isEnabled(embedEl: HTMLElement): boolean;
	getOptions(): OverlayOptions;
	/**
	 * Can the plugin actually write this embed's link right now? Checked
	 * once per embed change; handles only appear when true (no dead
	 * handles in popovers, canvas, unmappable sections, ...).
	 */
	canResize(embedEl: HTMLElement): boolean;
	/** Fail-fast target resolution at pointerdown. False aborts the drag. */
	beginDrag(embedEl: HTMLElement, visual: HTMLElement): boolean;
	/**
	 * Write the size ({kind:'none'} = double-click reset). Returns whether
	 * the document was actually written (the overlay reverts its visual
	 * feedback otherwise).
	 */
	commit(
		embedEl: HTMLElement,
		visual: HTMLElement,
		size: SizeSpec,
		/** Excalidraw writes the size as the first alias segment. */
		kind: EmbedKind,
	): boolean | Promise<boolean>;
}

export class EmbedHoverController {
	private overlay: ResizeOverlay | null = null;
	private currentEmbed: HTMLElement | null = null;
	private readonly cleanups: Array<() => void> = [];

	constructor(private readonly adapter: HoverAdapter) {
		this.delegate("pointerover");
		// Tap-to-select on touch; also re-shows after a click cleared it.
		this.delegate("pointerdown");
	}

	private delegate(type: string): void {
		const handler = (e: Event) => this.onPointerEvent(e);
		this.adapter.doc.addEventListener(type, handler);
		this.cleanups.push(() => this.adapter.doc.removeEventListener(type, handler));
	}

	get doc(): Document {
		return this.adapter.doc;
	}

	private onPointerEvent(e: Event): void {
		if (this.overlay?.isDragging) return;
		// Stale overlay: the embed was re-rendered under us — clear before
		// its dead handles can swallow the event.
		if (this.overlay && !this.overlay.visualConnected) this.clear();
		const el = asElement(e.target);
		// Pointer on our own handles/overlay: keep it.
		if (el && this.overlay?.contains(el)) return;

		// Hot path (every pointerover in the window): cheapest checks first,
		// the subtree-querying classification only on an embed change.
		const embedEl = el?.closest<HTMLElement>(".internal-embed") ?? null;
		if (!embedEl) {
			this.clear();
			return;
		}
		if (embedEl === this.currentEmbed) return;
		if (!this.adapter.isEnabled(embedEl) || !this.adapter.owns(embedEl)) {
			this.clear();
			return;
		}
		const hit = classifyEmbed(embedEl);
		if (!hit) {
			this.clear();
			return;
		}
		if (!this.adapter.canResize(embedEl)) {
			// Remember the embed anyway so the (non-trivial) probe does not
			// rerun on every pointerover inside it; leaving it resets.
			this.clear();
			this.currentEmbed = embedEl;
			return;
		}
		this.show(hit);
	}

	private show(hit: EmbedHit): void {
		this.clear();
		this.currentEmbed = hit.embedEl;
		const base = this.adapter.getOptions();
		const options = { ...base, sentinelMode: sentinelModeFor(base.sentinelMode, hit.kind) };
		const callbacks: OverlayCallbacks = {
			onDragStart: () => this.adapter.beginDrag(hit.embedEl, hit.visual),
			onCommit: (size) => this.adapter.commit(hit.embedEl, hit.visual, size, hit.kind),
			onReset: () => {
				void this.adapter.commit(hit.embedEl, hit.visual, { kind: "none" }, hit.kind);
			},
			onDetached: () => this.clear(),
			onContextMenu: (e) => openSizeMenu(this.adapter.app, e, hit, options, this.adapter),
		};
		this.overlay = new ResizeOverlay(hit.embedEl, hit.visual, options, callbacks);
		// Synchronous first placement (no one-frame flash at the wrong
		// spot); may call onDetached → clear() right away (hidden image).
		this.overlay.reposition();
	}

	/** Re-entrancy-safe (onDetached fires from inside overlay teardown). */
	clear(): void {
		const overlay = this.overlay;
		this.overlay = null;
		this.currentEmbed = null;
		overlay?.destroy();
	}

	/**
	 * Workspace changed (active leaf, layout, mode): drop the overlay —
	 * but never interrupt a drag in progress, and keep it when its embed
	 * lies inside `keepWithin` (e.g. the leaf that just became active by
	 * clicking/tapping that very image).
	 */
	clearIfIdle(keepWithin?: Element | null): void {
		if (this.overlay?.isDragging) return;
		if (keepWithin && this.currentEmbed && keepWithin.contains(this.currentEmbed)) return;
		this.clear();
	}

	/** Owner saw a layout/doc change — re-glue the overlay to the image. */
	scheduleReposition(): void {
		this.overlay?.scheduleReposition();
	}

	destroy(): void {
		this.clear();
		for (const cleanup of this.cleanups) cleanup();
		this.cleanups.length = 0;
	}
}
