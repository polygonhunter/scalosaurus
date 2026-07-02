/**
 * Reading Mode integration.
 *
 * Internal image embeds load asynchronously AFTER the markdown post
 * processor runs, so the post processor only records section-element →
 * context in a WeakMap; handle attachment happens lazily at hover time via
 * the shared EmbedHoverController (one per Document — main window and each
 * popout get their own, wired via window-open/close).
 *
 * Targeting: the embed's index among same-`src` embeds within its section
 * element (DOM) selects the N-th matching token within the section's source
 * lines — duplicate-safe. `getSectionInfo` is probed fail-fast at
 * pointerdown and fetched FRESH at commit ("only call this function right
 * before you need this information"); it may be null (PDF export, popovers,
 * edited sections) — every null/mismatch aborts with a Notice, never a
 * guessed write.
 *
 * Write routing: prefer an open source-mode editor of the same file (keeps
 * the resize inside the editor's undo history); otherwise `Vault.process`
 * with all parsing and replacement inside the synchronous callback (atomic,
 * conflict-safe).
 */

import {
	MarkdownView,
	Notice,
	TFile,
	type App,
	type Editor,
	type MarkdownPostProcessorContext,
} from "obsidian";
import { lineLooksLikeTableRow, parseEmbed, withSize, type SizeSpec } from "../core/parse";
import { snapConfigFrom, type ScalosaurusSettings } from "../settings";
import { EmbedHoverController } from "../ui/attach";
import type { OverlayOptions } from "../ui/overlay";
import { locateEmbedToken } from "./resolve-reading";

const ABORT_NOTICE = "Scalosaurus: could not safely locate the image link — not written.";

interface SectionContext {
	sectionEl: HTMLElement;
	ctx: MarkdownPostProcessorContext;
}

export class ReadingModeController {
	private readonly sections = new WeakMap<HTMLElement, MarkdownPostProcessorContext>();
	private readonly controllers = new Map<Document, EmbedHoverController>();

	constructor(
		private readonly app: App,
		private readonly getSettings: () => ScalosaurusSettings,
	) {}

	/** Register with plugin.registerMarkdownPostProcessor. */
	readonly postProcessor = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		this.sections.set(el, ctx);
	};

	/** Wire a window's document (main window at load, popouts on open). */
	wireDocument(doc: Document): void {
		if (this.controllers.has(doc)) return;
		this.controllers.set(
			doc,
			new EmbedHoverController({
				doc,
				owns: (embedEl) =>
					embedEl.closest(".markdown-preview-view") !== null &&
					this.findSectionContext(embedEl) !== null,
				isEnabled: () => this.getSettings().readingModeEnabled,
				getOptions: (): OverlayOptions => {
					const settings = this.getSettings();
					return {
						minWidth: settings.minWidth,
						snap: snapConfigFrom(settings),
						sentinelMode: settings.sentinelMode,
						unlockModifier: settings.unlockModifier,
					};
				},
				beginDrag: (embedEl) => this.beginDrag(embedEl),
				commit: (embedEl, _img, size) => {
					void this.commit(embedEl, size);
				},
			}),
		);
	}

	unwireDocument(doc: Document): void {
		this.controllers.get(doc)?.destroy();
		this.controllers.delete(doc);
	}

	destroy(): void {
		for (const controller of this.controllers.values()) controller.destroy();
		this.controllers.clear();
	}

	/** Walk up from the embed to the section element the post processor saw. */
	private findSectionContext(embedEl: Element): SectionContext | null {
		for (let el: Element | null = embedEl; el; el = el.parentElement) {
			const ctx = this.sections.get(el as HTMLElement);
			if (ctx) return { sectionEl: el as HTMLElement, ctx };
		}
		return null;
	}

	/** Fail-fast probe at pointerdown: abort before the user drags. */
	private beginDrag(embedEl: HTMLElement): boolean {
		const section = this.findSectionContext(embedEl);
		if (!section) return false;
		if (!embedEl.getAttribute("src")) return false;
		return section.ctx.getSectionInfo(section.sectionEl) !== null;
	}

	/**
	 * The embed's position among same-src siblings in the section DOM —
	 * mirrors locateEmbedToken's counting over the section's source lines.
	 * Counted at commit time, from the live DOM.
	 */
	private occurrenceIndex(section: SectionContext, embedEl: HTMLElement, src: string): number {
		const candidates = Array.from(
			section.sectionEl.querySelectorAll<HTMLElement>(".internal-embed.image-embed"),
		).filter(
			(el) => !el.closest(".markdown-embed") && el.getAttribute("src") === src,
		);
		return candidates.indexOf(embedEl);
	}

	private async commit(embedEl: HTMLElement, size: SizeSpec): Promise<void> {
		const section = this.findSectionContext(embedEl);
		const src = embedEl.getAttribute("src");
		if (!section || !src) {
			new Notice(ABORT_NOTICE);
			return;
		}
		// Fresh section info at write time — line numbers must reflect any
		// edits made while the drag was in flight.
		const info = section.ctx.getSectionInfo(section.sectionEl);
		if (!info) {
			new Notice(ABORT_NOTICE);
			return;
		}
		const occurrence = this.occurrenceIndex(section, embedEl, src);
		if (occurrence < 0) {
			new Notice(ABORT_NOTICE);
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(section.ctx.sourcePath);
		if (!(file instanceof TFile)) {
			new Notice(ABORT_NOTICE);
			return;
		}

		const apply = (lines: readonly string[]): { line: number; start: number; end: number; newToken: string } | null => {
			if (info.lineEnd >= lines.length) return null;
			const sectionLines = lines.slice(info.lineStart, info.lineEnd + 1);
			const located = locateEmbedToken(sectionLines, src, occurrence);
			if (!located) return null;
			const absLine = info.lineStart + located.lineOffset;
			const lineText = lines[absLine] as string;
			const parsed = parseEmbed(located.text);
			if (!parsed) return null;
			const newToken = withSize(located.text, size, {
				escapePipes: parsed.escapedPipes || lineLooksLikeTableRow(lineText),
			});
			if (newToken === null) return null;
			return { line: absLine, start: located.start, end: located.end, newToken };
		};

		// Route through an open source-mode editor of the same file when one
		// exists: the resize then lands in that editor's undo history.
		const editor = this.findSourceEditor(section.ctx.sourcePath);
		if (editor) {
			const lines: string[] = [];
			for (let i = 0; i < editor.lineCount(); i++) lines.push(editor.getLine(i));
			const change = apply(lines);
			if (!change) {
				new Notice(ABORT_NOTICE);
				return;
			}
			if (change.newToken === lines[change.line]?.slice(change.start, change.end)) return;
			editor.replaceRange(
				change.newToken,
				{ line: change.line, ch: change.start },
				{ line: change.line, ch: change.end },
			);
			return;
		}

		// Atomic read-modify-write; verification happens INSIDE the
		// synchronous callback, against the data actually on disk.
		let failed = false;
		let changed = false;
		await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			const change = apply(lines);
			if (!change) {
				failed = true;
				return data;
			}
			const lineText = lines[change.line] as string;
			const newLine =
				lineText.slice(0, change.start) + change.newToken + lineText.slice(change.end);
			if (newLine === lineText) return data;
			changed = true;
			lines[change.line] = newLine;
			return lines.join("\n");
		});
		if (failed) new Notice(ABORT_NOTICE);
		// Obsidian re-renders changed blocks on vault modification; the
		// overlay's inline styles keep the visual size stable meanwhile.
		void changed;
	}

	private findSourceEditor(path: string): Editor | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			if (view.file?.path !== path) continue;
			if (view.getMode() !== "source") continue;
			return view.editor;
		}
		return null;
	}
}
