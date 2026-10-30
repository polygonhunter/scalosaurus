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
 * lines — duplicate-safe. The source side is scanned with non-rendered text
 * masked out (code, comments), and three invariants guard every write:
 *   1. getSectionInfo is probed fail-fast at pointerdown and fetched FRESH
 *      at commit; null (PDF export, popovers, edited sections) aborts.
 *   2. The buffer/disk lines of the section must equal the render-time
 *      lines from `info.text` — stale line windows abort.
 *   3. The masked source token count must equal the DOM embed count — if
 *      the occurrence mapping cannot be trusted (markdown-syntax images,
 *      masking approximation), abort instead of guessing.
 * Every abort shows a Notice; a wrong-token write must be impossible.
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
	type MarkdownSectionInformation,
} from "obsidian";
import type { SizeSpec } from "../core/parse";
import { overlayOptionsFrom, type ScalosaurusSettings } from "../settings";
import {
	collectEligibleEmbeds,
	EmbedHoverController,
	embedInTable,
	type EmbedKind,
} from "../ui/attach";
import {
	linesSource,
	planSectionRewrite,
	plannedNoop,
	revertLine,
	scanEmbedTokens,
	sliceLines,
	type RewritePlan,
	type SectionRewriteInput,
} from "./resolve-reading";

const ABORT_NOTICE = "Scalosaurus: could not safely locate the image link — not written.";

const UNDO_NOTICE_MS = 6000;
const UNDO_FAILED_NOTICE = "Scalosaurus: the image link changed since — nothing undone.";

/** Show the abort notice; returns false for `return abort();`. */
function abort(): false {
	new Notice(ABORT_NOTICE);
	return false;
}

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
				app: this.app,
				doc,
				owns: (embedEl) =>
					embedEl.closest(".markdown-preview-view") !== null &&
					this.findSectionContext(embedEl) !== null,
				isEnabled: () => this.getSettings().readingModeEnabled,
				getOptions: () => overlayOptionsFrom(this.getSettings()),
				// The pointerdown probe is side-effect free — reuse it.
				canResize: (embedEl) => this.beginDrag(embedEl),
				beginDrag: (embedEl) => this.beginDrag(embedEl),
				commit: (embedEl, _img, size, kind) => this.commit(embedEl, size, kind),
			}),
		);
	}

	unwireDocument(doc: Document): void {
		this.controllers.get(doc)?.destroy();
		this.controllers.delete(doc);
	}

	/** Drop visible overlays (workspace changed); drags are left alone. */
	clearAll(keepWithin?: Element | null): void {
		for (const controller of this.controllers.values()) controller.clearIfIdle(keepWithin);
	}

	destroy(): void {
		for (const controller of this.controllers.values()) controller.destroy();
		this.controllers.clear();
	}

	/**
	 * Walk up from the embed to the section element the post processor saw.
	 * Nested renders (e.g. a callout body) can register an inner element
	 * whose getSectionInfo is null — keep walking up to the first section
	 * that can be mapped; fall back to the innermost one (which aborts).
	 */
	private findSectionContext(embedEl: Element): SectionContext | null {
		let innermost: SectionContext | null = null;
		for (let el: Element | null = embedEl; el; el = el.parentElement) {
			const ctx = this.sections.get(el as HTMLElement);
			if (!ctx) continue;
			const section = { sectionEl: el as HTMLElement, ctx };
			if (ctx.getSectionInfo(section.sectionEl)) return section;
			innermost ??= section;
		}
		return innermost;
	}

	/**
	 * Rendered same-src embeds within the section, in DOM order — the DOM
	 * side of the occurrence mapping. Uses the same eligibility rules as the
	 * hover controller (images + Excalidraw drawings, transclusions
	 * excluded); trimmed comparison, matching how pathMatchesSrc compares
	 * link targets on the source side.
	 */
	private sectionCandidates(section: SectionContext, src: string): HTMLElement[] {
		return collectEligibleEmbeds(section.sectionEl)
			.map((hit) => hit.embedEl)
			.filter((el) => (el.getAttribute("src") ?? "").trim() === src.trim());
	}

	/** Render-time section lines out of getSectionInfo's whole-file text. */
	private sectionLinesFromInfo(info: MarkdownSectionInformation): string[] | null {
		return sliceLines(info.text, info.lineStart, info.lineEnd);
	}

	/**
	 * Fail-fast probe at pointerdown (and hover-time canResize): abort
	 * before the user drags. Runs the same occurrence/count invariants as
	 * the commit, against render-time text — markdown-syntax images and
	 * untrustworthy sections never even start a drag. Side-effect free.
	 */
	private beginDrag(embedEl: HTMLElement): boolean {
		const section = this.findSectionContext(embedEl);
		if (!section) return false;
		const src = embedEl.getAttribute("src");
		if (!src) return false;
		const info = section.ctx.getSectionInfo(section.sectionEl);
		if (!info) return false;
		const sectionLines = this.sectionLinesFromInfo(info);
		if (!sectionLines) return false;
		const candidates = this.sectionCandidates(section, src);
		const occurrence = candidates.indexOf(embedEl);
		if (occurrence < 0) return false;
		const scan = scanEmbedTokens(sectionLines, src, occurrence);
		return scan.count === candidates.length && scan.located !== null;
	}

	/** Returns true only when the document was actually written. */
	private async commit(embedEl: HTMLElement, size: SizeSpec, kind: EmbedKind): Promise<boolean> {
		const section = this.findSectionContext(embedEl);
		const src = embedEl.getAttribute("src");
		if (!section || !src) return abort();
		// Fresh section info at write time — line numbers must reflect any
		// edits made while the drag was in flight.
		const info = section.ctx.getSectionInfo(section.sectionEl);
		if (!info) return abort();
		const renderLines = this.sectionLinesFromInfo(info);
		if (!renderLines) return abort();
		const candidates = this.sectionCandidates(section, src);
		const occurrence = candidates.indexOf(embedEl);
		if (occurrence < 0) return abort();

		const file = this.app.vault.getAbstractFileByPath(section.ctx.sourcePath);
		if (!(file instanceof TFile)) return abort();

		const input: SectionRewriteInput = {
			lineStart: info.lineStart,
			lineEnd: info.lineEnd,
			renderLines,
			src,
			occurrence,
			domCount: candidates.length,
			size,
			inTable: embedInTable(embedEl),
			sizeFirst: kind === "excalidraw",
		};

		// Route through an open source-mode editor of the same file when one
		// exists: the resize then lands in that editor's undo history. Only
		// the section window is read from the editor.
		const editor = this.findSourceEditor(section.ctx.sourcePath);
		if (editor) {
			const plan = planSectionRewrite(editor, input);
			if (!plan) return abort();
			if (plannedNoop(plan)) return false;
			editor.replaceRange(
				plan.newToken,
				{ line: plan.line, ch: plan.start },
				{ line: plan.line, ch: plan.end },
			);
			return true;
		}

		// Atomic read-modify-write; verification happens INSIDE the
		// synchronous callback, against the data actually on disk.
		let failed = false;
		let written: RewritePlan | null = null;
		try {
			await this.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const plan = planSectionRewrite(linesSource(lines), input);
				if (!plan) {
					failed = true;
					return data;
				}
				if (plannedNoop(plan)) return data;
				const lineText = lines[plan.line] as string;
				lines[plan.line] =
					lineText.slice(0, plan.start) + plan.newToken + lineText.slice(plan.end);
				written = plan;
				return lines.join("\n");
			});
		} catch (error) {
			// File deleted/renamed meanwhile, or the write itself failed.
			console.error("Scalosaurus: resize write failed", error);
			return abort();
		}
		if (failed) new Notice(ABORT_NOTICE);
		if (written) this.offerUndo(file, written);
		// Obsidian re-renders changed blocks on vault modification; the
		// overlay's inline styles keep the visual size stable meanwhile.
		return written !== null;
	}

	/**
	 * Writes via vault.process bypass every editor undo history — offer a
	 * one-click undo for a few seconds instead.
	 */
	private offerUndo(file: TFile, plan: RewritePlan): void {
		let notice: Notice | null = null;
		const fragment = createFragment((f) => {
			f.createSpan({ text: "Scalosaurus: image resized. " });
			const button = f.createEl("button", { text: "Undo" });
			button.addEventListener("click", () => {
				notice?.hide();
				void this.undo(file, plan);
			});
		});
		notice = new Notice(fragment, UNDO_NOTICE_MS);
	}

	private async undo(file: TFile, plan: RewritePlan): Promise<void> {
		let reverted = false;
		try {
			await this.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const line = revertLine(lines[plan.line], plan);
				if (line === null) return data;
				lines[plan.line] = line;
				reverted = true;
				return lines.join("\n");
			});
		} catch (error) {
			console.error("Scalosaurus: undo write failed", error);
		}
		if (!reverted) new Notice(UNDO_FAILED_NOTICE);
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
