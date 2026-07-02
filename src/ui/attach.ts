/**
 * Shared hover/tap → overlay lifecycle used by both the Live Preview
 * ViewPlugin and the Reading Mode controller. Listens (delegated) on a
 * Document for pointerover (hover) and pointerdown (tap-to-select — hover
 * does not exist on touch), shows one ResizeOverlay for the embed under the
 * pointer and clears it when the pointer moves elsewhere.
 */

import type { SizeSpec } from "../core/parse";
import { ResizeOverlay, type OverlayCallbacks, type OverlayOptions } from "./overlay";

export interface EmbedHit {
	embedEl: HTMLElement;
	img: HTMLImageElement;
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
 * Is this event target an image embed Scalosaurus may resize?
 * Excludes transclusions: an image inside a `.markdown-embed` container has
 * its `![[...]]` token in ANOTHER file — never touch those from here.
 */
export function eligibleImageEmbed(target: EventTarget | null): EmbedHit | null {
	const el = asElement(target);
	if (!el) return null;
	const embedEl = el.closest<HTMLElement>(".internal-embed.image-embed");
	if (!embedEl) return null;
	if (embedEl.closest(".markdown-embed")) return null;
	const img = embedEl.querySelector("img");
	if (!img || !img.isConnected) return null;
	return { embedEl, img };
}

export interface HoverAdapter {
	/** Document to delegate on (per window — popout-safe). */
	doc: Document;
	/** Scope: does this controller own the given embed element? */
	owns(embedEl: Element): boolean;
	isEnabled(): boolean;
	getOptions(): OverlayOptions;
	/** Fail-fast target resolution at pointerdown. False aborts the drag. */
	beginDrag(embedEl: HTMLElement, img: HTMLImageElement): boolean;
	/**
	 * Write the size ({kind:'none'} = double-click reset). Returns whether
	 * the document was actually written (the overlay reverts its visual
	 * feedback otherwise).
	 */
	commit(
		embedEl: HTMLElement,
		img: HTMLImageElement,
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

	get document(): Document {
		return this.adapter.doc;
	}

	private onPointerEvent(e: Event): void {
		if (this.overlay?.isDragging) return;
		// Stale overlay: the image was re-rendered under us — clear before
		// its dead handles can swallow the event.
		if (this.overlay && !this.overlay.imgConnected) this.clear();
		const el = asElement(e.target);
		// Pointer on our own handles/overlay: keep it.
		if (el && this.overlay?.contains(el)) return;

		const hit = eligibleImageEmbed(e.target);
		if (hit && this.adapter.owns(hit.embedEl) && this.adapter.isEnabled()) {
			if (this.currentEmbed !== hit.embedEl) this.show(hit);
			return;
		}
		this.clear();
	}

	private show(hit: EmbedHit): void {
		this.clear();
		this.currentEmbed = hit.embedEl;
		const callbacks: OverlayCallbacks = {
			onDragStart: () => this.adapter.beginDrag(hit.embedEl, hit.img),
			onCommit: (size) => this.adapter.commit(hit.embedEl, hit.img, size),
			onReset: () => this.adapter.commit(hit.embedEl, hit.img, { kind: "none" }),
			onDetached: () => this.clear(),
		};
		this.overlay = new ResizeOverlay(hit.embedEl, hit.img, this.adapter.getOptions(), callbacks);
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
