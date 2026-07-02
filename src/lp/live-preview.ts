/**
 * Live Preview integration: one ViewPlugin instance per EditorView (every
 * pane and popout gets its own). Hover/tap handling is delegated to the
 * shared EmbedHoverController; commits dispatch a single CM6 transaction
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
import { editorLivePreviewField, Notice } from "obsidian";
import { lineLooksLikeTableRow, parseEmbed, withSize, type SizeSpec } from "../core/parse";
import { snapConfigFrom, type ScalosaurusSettings } from "../settings";
import { EmbedHoverController } from "../ui/attach";
import type { OverlayOptions } from "../ui/overlay";
import { resolveLpTarget, type LpTarget } from "./resolve-lp";

export const ABORT_NOTICE = "Scalosaurus: note changed during resize — not written.";

export function buildLivePreviewExtension(
	getSettings: () => ScalosaurusSettings,
): Extension {
	return ViewPlugin.define((view) => new LivePreviewResize(view, getSettings));
}

class LivePreviewResize implements PluginValue {
	private controller: EmbedHoverController;
	/** Target captured at pointerdown, for the pointerup sanity check. */
	private captured: LpTarget | null = null;

	constructor(
		private readonly view: EditorView,
		private readonly getSettings: () => ScalosaurusSettings,
	) {
		this.controller = this.buildController(view.dom.ownerDocument);
	}

	private buildController(doc: Document): EmbedHoverController {
		const view = this.view;
		return new EmbedHoverController({
			doc,
			owns: (embedEl) => view.contentDOM.contains(embedEl),
			// Inert in Source Mode — images only render in Live Preview.
			isEnabled: () => view.state.field(editorLivePreviewField, false) === true,
			getOptions: (): OverlayOptions => {
				const settings = this.getSettings();
				return {
					minWidth: settings.minWidth,
					snap: snapConfigFrom(settings),
					sentinelMode: settings.sentinelMode,
					unlockModifier: settings.unlockModifier,
				};
			},
			beginDrag: (embedEl) => {
				this.captured = resolveLpTarget(this.view, embedEl);
				return this.captured !== null;
			},
			commit: (embedEl, _img, size) => this.commit(embedEl, size),
		});
	}

	update(update: ViewUpdate): void {
		// Moving a pane into a popout window adopts the editor DOM into a
		// NEW document without re-instantiating this ViewPlugin — rebuild
		// the controller so its delegated listeners live on the right doc.
		const doc = this.view.dom.ownerDocument;
		if (doc !== this.controller.document) {
			this.controller.destroy();
			this.controller = this.buildController(doc);
		}
		// Re-glue the overlay after edits/scrolling. scheduleReposition works
		// via requestAnimationFrame, so no layout reads inside this update.
		if (update.docChanged || update.viewportChanged || update.geometryChanged) {
			this.controller.scheduleReposition();
		}
	}

	destroy(): void {
		this.controller.destroy();
	}

	/** Returns true only when the document was actually written. */
	private commit(embedEl: HTMLElement, size: SizeSpec): boolean {
		const captured = this.captured;
		this.captured = null;

		const fresh = resolveLpTarget(this.view, embedEl);
		if (!fresh) {
			new Notice(ABORT_NOTICE);
			return false;
		}
		const freshParsed = parseEmbed(fresh.text);
		if (!freshParsed) {
			new Notice(ABORT_NOTICE);
			return false;
		}
		// The token may legitimately differ from pointerdown (e.g. another
		// actor tweaked the size mid-drag) — but it must still be the same
		// image. Rewrite the FRESH text, never the stale capture.
		if (captured) {
			const capturedParsed = parseEmbed(captured.text);
			if (capturedParsed && capturedParsed.path.trim() !== freshParsed.path.trim()) {
				new Notice(ABORT_NOTICE);
				return false;
			}
		}

		const newToken = withSize(fresh.text, size, {
			escapePipes: freshParsed.escapedPipes || lineLooksLikeTableRow(fresh.lineText),
		});
		if (newToken === null || newToken === fresh.text) return false;

		// Single dispatch = one undo step; selection maps automatically.
		this.view.dispatch({
			changes: { from: fresh.from, to: fresh.to, insert: newToken },
			userEvent: "input.scalosaurus-resize",
		});
		return true;
	}
}
