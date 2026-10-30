/**
 * Pure token location for Reading Mode. Given the source lines of a section
 * (from `getSectionInfo`) and the embed's `src` attribute, find the N-th
 * token whose link target matches — mirroring how the caller counted the
 * embed's index among same-src `.image-embed` elements in the section DOM.
 *
 * Scanning happens on MASKED lines (maskNonRenderedText): tokens inside
 * inline code, fenced code blocks, `%%...%%` or `<!-- -->` comments exist
 * in the source but never render an embed — counting them would silently
 * retarget the write to the wrong token (e.g. rewriting a code sample
 * instead of the dragged image). Offsets are mask-stable, so ranges and
 * text are taken from the ORIGINAL lines.
 *
 * No `obsidian` imports — unit-tested directly.
 */

import {
	findEmbedTokens,
	maskNonRenderedText,
	needsEscapedPipes,
	parseEmbed,
	pathMatchesSrc,
	withSize,
	type SizeSpec,
} from "../core/parse";

export interface LocatedToken {
	/** 0-based index into the passed `lines` array. */
	lineOffset: number;
	/** Char offsets within that line. */
	start: number;
	end: number;
	text: string;
}

export interface TokenScan {
	/** Rendered tokens with link target `src` (DOM-count cross-check). */
	count: number;
	/** The `occurrence`-th of them, or null when it does not exist. */
	located: LocatedToken | null;
}

/**
 * One pass over the (masked) lines: counts every rendered token with link
 * target `src` and picks the `occurrence`-th (0-based) on the way. Offsets
 * are mask-stable, so ranges and text are taken from the ORIGINAL lines.
 */
export function scanEmbedTokens(
	lines: readonly string[],
	src: string,
	occurrence: number,
): TokenScan {
	const masked = maskNonRenderedText(lines);
	let count = 0;
	let located: LocatedToken | null = null;
	for (let i = 0; i < lines.length; i++) {
		const maskedLine = masked[i] as string;
		// Cheap pre-filter: no token opener on this line → nothing to parse.
		if (!maskedLine.includes("![[")) continue;
		const original = lines[i] as string;
		for (const match of findEmbedTokens(maskedLine)) {
			const text = original.slice(match.start, match.end);
			const parsed = parseEmbed(text);
			if (!parsed || !pathMatchesSrc(parsed, src)) continue;
			if (count === occurrence) {
				located = { lineOffset: i, start: match.start, end: match.end, text };
			}
			count++;
		}
	}
	return { count, located };
}

/**
 * Find the `occurrence`-th (0-based) rendered embed token with link target
 * `src` within `lines`. Returns null when there is no such occurrence —
 * callers must treat that as "note changed, do not write".
 */
export function locateEmbedToken(
	lines: readonly string[],
	src: string,
	occurrence: number,
): LocatedToken | null {
	return scanEmbedTokens(lines, src, occurrence).located;
}

/**
 * How many rendered embed tokens with link target `src` do these lines
 * contain? Cross-checked against the DOM count before any write: a
 * mismatch means the source↔DOM occurrence mapping cannot be trusted
 * (masking approximation, markdown-syntax images, hidden tokens) and the
 * caller must abort instead of guessing.
 */
export function countEmbedTokens(lines: readonly string[], src: string): number {
	return scanEmbedTokens(lines, src, -1).count;
}

/**
 * Lines `lineStart..lineEnd` (inclusive) of `text` — without splitting the
 * whole file (getSectionInfo hands us the entire note for every section).
 * Null when the window does not fit the text.
 */
export function sliceLines(text: string, lineStart: number, lineEnd: number): string[] | null {
	if (lineStart < 0 || lineEnd < lineStart) return null;
	let from = 0;
	for (let i = 0; i < lineStart; i++) {
		const nl = text.indexOf("\n", from);
		if (nl < 0) return null;
		from = nl + 1;
	}
	let to = from;
	for (let i = lineStart; i < lineEnd; i++) {
		const nl = text.indexOf("\n", to);
		if (nl < 0) return null;
		to = nl + 1;
	}
	const endNl = text.indexOf("\n", to);
	return text.slice(from, endNl < 0 ? text.length : endNl).split("\n");
}

/** Line access shared by an array of lines and Obsidian's `Editor`. */
export interface LineSource {
	lineCount(): number;
	getLine(line: number): string;
}

export function linesSource(lines: readonly string[]): LineSource {
	return {
		lineCount: () => lines.length,
		getLine: (i) => lines[i] as string,
	};
}

export interface SectionRewriteInput {
	/** Section window from getSectionInfo (0-based, inclusive). */
	lineStart: number;
	lineEnd: number;
	/** The section's lines as they were RENDERED (from info.text). */
	renderLines: readonly string[];
	src: string;
	/** Index of the dragged embed among same-src embeds in the section DOM. */
	occurrence: number;
	/** Number of same-src embeds in the section DOM. */
	domCount: number;
	size: SizeSpec;
	/** Rendered-DOM table signal (td/th). */
	inTable: boolean;
	/** Write the size as the first alias segment (Excalidraw embeds). */
	sizeFirst?: boolean;
}

export interface RewritePlan {
	/** Absolute 0-based line in the source. */
	line: number;
	start: number;
	end: number;
	oldToken: string;
	newToken: string;
}

export function plannedNoop(plan: RewritePlan): boolean {
	return plan.newToken === plan.oldToken;
}

/**
 * Trailing `\r` (CRLF files) is ignored for COMPARISON only: the editor
 * hands out lines without it, getSectionInfo/vault data keep it. Writes
 * stay inside the line, so an existing `\r` is preserved.
 */
function stripCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Pure Reading Mode write plan. Reads only the section window from
 * `source` and enforces the invariants:
 *   - the window still exists (file not shortened),
 *   - the current lines equal the rendered lines (stale window → null),
 *   - the masked source count equals the DOM count (mapping trustworthy),
 *   - the occurrence exists.
 * Returns null on any violation — callers abort with a Notice. A plan whose
 * newToken equals oldToken is a no-op (see plannedNoop).
 */
export function planSectionRewrite(
	source: LineSource,
	input: SectionRewriteInput,
): RewritePlan | null {
	const { lineStart, lineEnd, renderLines } = input;
	if (lineStart < 0 || lineEnd < lineStart || lineEnd >= source.lineCount()) return null;
	if (lineEnd - lineStart + 1 !== renderLines.length) return null;
	const sectionLines: string[] = [];
	for (let i = lineStart; i <= lineEnd; i++) {
		const line = source.getLine(i);
		if (stripCr(line) !== stripCr(renderLines[i - lineStart] as string)) return null;
		sectionLines.push(line);
	}
	const scan = scanEmbedTokens(sectionLines, input.src, input.occurrence);
	if (scan.count !== input.domCount || !scan.located) return null;
	const located = scan.located;
	const parsed = parseEmbed(located.text);
	if (!parsed) return null;
	const lineText = sectionLines[located.lineOffset] as string;
	const newToken = withSize(located.text, input.size, {
		escapePipes: needsEscapedPipes(parsed, lineText, input.inTable),
		sizeFirst: input.sizeFirst,
	});
	if (newToken === null) return null;
	return {
		line: lineStart + located.lineOffset,
		start: located.start,
		end: located.end,
		oldToken: located.text,
		newToken,
	};
}

/**
 * Undo of a written plan, for writes outside any editor (no undo history).
 * Only when the line still holds EXACTLY the new token at the written
 * column — anything else (edited meanwhile, line moved) returns null and
 * nothing is reverted.
 */
export function revertLine(lineText: string | undefined, plan: RewritePlan): string | null {
	if (lineText === undefined) return null;
	const end = plan.start + plan.newToken.length;
	if (lineText.slice(plan.start, end) !== plan.newToken) return null;
	return lineText.slice(0, plan.start) + plan.oldToken + lineText.slice(end);
}
