/**
 * Live Preview integration: one ViewPlugin instance per EditorView (every
 * pane and popout gets its own), all sharing ONE EmbedHoverController per
 * Document (see buildLivePreviewExtension); commits dispatch a single CM6 transaction
 * from the pointer-event handler — NEVER from ViewPlugin.update ("calls to
 * EditorView.update are not allowed while an update is in progress").
 *
 * Verify-before-write: the target is resolved fail-fast at pointerdown
 * (abort before the user invests in a drag) and re-resolved FRESH at
 * pointerup — a drag can span seconds during which sync, another pane or
 * another plugin may edit the document. On any mismatch: Notice, no write.
 */

import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { editorLivePreviewField, Notice, type App } from "obsidian";
import type { SizeSpec } from "../core/parse";
import { overlayOptionsFrom, type ScalosaurusSettings } from "../settings";
import { embedInTable, EmbedHoverController } from "../ui/attach";
import { planLpRewrite, resolveLpTarget, type LpTarget } from "./resolve-lp";

export const ABORT_NOTICE = "Scalosaurus: note changed during resize — not written.";

/**
 * One EmbedHoverController per Document for ALL Live Preview editors in it
 * (previously one per EditorView = N document-wide listener sets). Each
 * ViewPlugin registers itself; the shared adapter routes every embed to the
 * INNERMOST editor containing it (`closest('.cm-editor') === view.dom`), so
 * nested editors can no longer both claim — and double-overlay — one embed.
 */
interface DocEntry {
	controller: EmbedHoverController;
	views: Set<LivePreviewResize>;
}

export interface LivePreviewIntegration {
	extension: Extension;
	/** Drop every visible LP overlay (leaf/layout change). */
	clearAll(keepWithin?: Element | null): void;
}

export function buildLivePreviewExtension(
	app: App,
	getSettings: () => ScalosaurusSettings,
): LivePreviewIntegration {
	const registry = new Map<Document, DocEntry>();

	const ownerOf = (views: Set<LivePreviewResize>, embedEl: HTMLElement) => {
		const editorEl = embedEl.closest(".cm-editor");
		if (!editorEl) return null;
		for (const v of views) if (v.view.dom === editorEl) return v;
		return null;
	};

	const register = (doc: Document, v: LivePreviewResize): DocEntry => {
		let entry = registry.get(doc);
		if (!entry) {
			const views = new Set<LivePreviewResize>();
			const controller = new EmbedHoverController({
				app,
				doc,
				owns: (embedEl) => ownerOf(views, embedEl) !== null,
				isEnabled: (embedEl) => ownerOf(views, embedEl)?.isLivePreview() === true,
				getOptions: () => overlayOptionsFrom(getSettings()),
				canResize: (embedEl) => ownerOf(views, embedEl)?.canResize(embedEl) === true,
				beginDrag: (embedEl) => ownerOf(views, embedEl)?.beginDrag(embedEl) ?? false,
				commit: (embedEl, _visual, size) => {
					const owner = ownerOf(views, embedEl);
					if (!owner) {
						new Notice(ABORT_NOTICE);
						return false;
					}
					return owner.commit(embedEl, size);
				},
			});
			entry = { controller, views };
			registry.set(doc, entry);
		}
		entry.views.add(v);
		return entry;
	};

	const unregister = (doc: Document, v: LivePreviewResize): void => {
		const entry = registry.get(doc);
		if (!entry) return;
		entry.views.delete(v);
		if (entry.views.size === 0) {
			entry.controller.destroy();
			registry.delete(doc);
		}
	};

	const extension = ViewPlugin.define(
		(view) => new LivePreviewResize(view, { register, unregister }),
	);
	return {
		extension,
		clearAll: (keepWithin) => {
			for (const entry of registry.values()) entry.controller.clearIfIdle(keepWithin);
		},
	};
}

interface Registry {
	register(doc: Document, v: LivePreviewResize): DocEntry;
	unregister(doc: Document, v: LivePreviewResize): void;
}

class LivePreviewResize implements PluginValue {
	private doc: Document;
	private entry: DocEntry;
	/** Target captured at pointerdown, for the pointerup sanity check. */
	private captured: LpTarget | null = null;

	constructor(
		readonly view: EditorView,
		private readonly registry: Registry,
	) {
		this.doc = view.dom.ownerDocument;
		this.entry = registry.register(this.doc, this);
	}

	/** Inert in Source Mode — images only render in Live Preview. */
	isLivePreview(): boolean {
		return this.view.state.field(editorLivePreviewField, false) === true;
	}

	canResize(embedEl: HTMLElement): boolean {
		return resolveLpTarget(this.view, embedEl) !== null;
	}

	beginDrag(embedEl: HTMLElement): boolean {
		this.captured = resolveLpTarget(this.view, embedEl);
		return this.captured !== null;
	}

	update(update: ViewUpdate): void {
		// Moving a pane into a popout window adopts the editor DOM into a
		// NEW document without re-instantiating this ViewPlugin — move our
		// registration so the delegated listeners live on the right doc.
		const doc = this.view.dom.ownerDocument;
		if (doc !== this.doc) {
			this.registry.unregister(this.doc, this);
			this.doc = doc;
			this.entry = this.registry.register(doc, this);
		}
		// Re-glue the overlay after edits/scrolling. scheduleReposition works
		// via requestAnimationFrame, so no layout reads inside this update.
		if (update.docChanged || update.viewportChanged || update.geometryChanged) {
			this.entry.controller.scheduleReposition();
		}
	}

	destroy(): void {
		this.registry.unregister(this.doc, this);
	}

	/** Returns true only when the document was actually written. */
	commit(embedEl: HTMLElement, size: SizeSpec): boolean {
		const captured = this.captured;
		this.captured = null;
		const fresh = resolveLpTarget(this.view, embedEl);
		const plan = planLpRewrite(captured, fresh, size, embedInTable(embedEl));
		if (plan.kind === "abort") {
			new Notice(ABORT_NOTICE);
			return false;
		}
		if (plan.kind === "noop") return false;
		// Single dispatch = one undo step; selection maps automatically.
		this.view.dispatch({
			changes: { from: plan.from, to: plan.to, insert: plan.insert },
			userEvent: "input.scalosaurus-resize",
		});
		return true;
	}
}
