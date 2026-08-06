/**
 * Shared hover/tap → overlay lifecycle used by both the Live Preview
 * ViewPlugin and the Reading Mode controller. Listens (delegated) on a
 * Document for pointerover (hover) and pointerdown (tap-to-select — hover
 * does not exist on touch), shows one ResizeOverlay for the embed under the
 * pointer and clears it when the pointer moves elsewhere.
 */

import type { SizeSpec } from "../core/parse";
import { ResizeOverlay, type OverlayCallbacks, type OverlayOptions } from "./overlay";

/**
 * What kind of embed the handles are attached to. Excalidraw drawings are
 * markdown files whose embeds render as `.markdown-embed`, but unlike a
 * note transclusion their `![[...]]` token lives in the CURRENT file, so
 * resizing them is safe — they just don't understand the `|100%` sentinel
 * (snap writes measured px for them instead).
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
 * DOM markers the Excalidraw plugin puts on embedded drawings. Empirical —
 * see docs/findings.md (gate 5); adjust here if a plugin update renames them.
 */
const EXCALIDRAW_VISUAL_SELECTOR =
	"img.excalidraw-embedded-img, svg.excalidraw-svg, .excalidraw-embedded-img, .excalidraw-svg";

function excalidrawSrc(embedEl: HTMLElement): boolean {
	const src = (embedEl.getAttribute("src") ?? "").split("#")[0]?.trim().toLowerCase() ?? "";
	return src.endsWith(".excalidraw") || src.endsWith(".excalidraw.md");
}

/**
 * Classify one `.internal-embed` container. Returns null when Scalosaurus
 * must not touch it. Transclusion rule: the embed itself may be a
 * markdown-embed (Excalidraw), but nothing ABOVE it may be one — an
 * enclosing `.markdown-embed` means the token lives in another file.
 */
export function classifyEmbed(embedEl: HTMLElement): EmbedHit | null {
	if (embedEl.parentElement?.closest(".markdown-embed")) return null;

	if (embedEl.classList.contains("image-embed")) {
		const img = embedEl.querySelector("img");
		if (!img || !img.isConnected) return null;
		return { embedEl, visual: img, kind: "image" };
	}

	const marked = embedEl.querySelector<HTMLElement>(EXCALIDRAW_VISUAL_SELECTOR);
	if (marked?.isConnected) return { embedEl, visual: marked, kind: "excalidraw" };

	if (excalidrawSrc(embedEl)) {
		const visual = embedEl.querySelector<HTMLElement>("svg, img");
		if (visual?.isConnected) return { embedEl, visual, kind: "excalidraw" };
	}
	return null;
}

/** Is this event target an embed Scalosaurus may resize? */
export function eligibleEmbed(target: EventTarget | null): EmbedHit | null {
	const el = asElement(target);
	if (!el) return null;
	const embedEl = el.closest<HTMLElement>(".internal-embed");
	if (!embedEl) return null;
	return classifyEmbed(embedEl);
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
	/** Document to delegate on (per window — popout-safe). */
	doc: Document;
	/** Scope: does this controller own the given embed element? */
	owns(embedEl: Element): boolean;
	isEnabled(): boolean;
	getOptions(): OverlayOptions;
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

		const hit = eligibleEmbed(e.target);
		if (hit && this.adapter.owns(hit.embedEl) && this.adapter.isEnabled()) {
			if (this.currentEmbed !== hit.embedEl) this.show(hit);
			return;
		}
		this.clear();
	}

	private show(hit: EmbedHit): void {
		this.clear();
		this.currentEmbed = hit.embedEl;
		let options = this.adapter.getOptions();
		if (hit.kind !== "image") {
			// Non-image embeds don't render the responsive sentinel (the CSS
			// targets image embeds' alt) — snapped commits write measured px.
			options = { ...options, sentinelMode: "px" };
		}
		const callbacks: OverlayCallbacks = {
			onDragStart: () => this.adapter.beginDrag(hit.embedEl, hit.visual),
			onCommit: (size) => this.adapter.commit(hit.embedEl, hit.visual, size),
			onReset: () => {
				void this.adapter.commit(hit.embedEl, hit.visual, { kind: "none" });
			},
			onDetached: () => this.clear(),
		};
		this.overlay = new ResizeOverlay(hit.embedEl, hit.visual, options, callbacks);
	}

	/** Re-entrancy-safe (onDetached fires from inside overlay teardown). */
	clear(): void {
		const overlay = this.overlay;
		this.overlay = null;
		this.currentEmbed = null;
		overlay?.destroy();
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
