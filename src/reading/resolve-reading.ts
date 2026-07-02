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

import { findEmbedTokens, maskNonRenderedText, parseEmbed, pathMatchesSrc } from "../core/parse";

export interface LocatedToken {
	/** 0-based index into the passed `lines` array. */
	lineOffset: number;
	/** Char offsets within that line. */
	start: number;
	end: number;
	text: string;
}

function* matchingTokens(
	lines: readonly string[],
	src: string,
): Generator<LocatedToken> {
	const masked = maskNonRenderedText(lines);
	for (let i = 0; i < lines.length; i++) {
		const original = lines[i] as string;
		for (const match of findEmbedTokens(masked[i] as string)) {
			const text = original.slice(match.start, match.end);
			const parsed = parseEmbed(text);
			if (!parsed || !pathMatchesSrc(parsed, src)) continue;
			yield { lineOffset: i, start: match.start, end: match.end, text };
		}
	}
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
	let seen = 0;
	for (const token of matchingTokens(lines, src)) {
		if (seen === occurrence) return token;
		seen++;
	}
	return null;
}

/**
 * How many rendered embed tokens with link target `src` do these lines
 * contain? Cross-checked against the DOM count before any write: a
 * mismatch means the source↔DOM occurrence mapping cannot be trusted
 * (masking approximation, markdown-syntax images, hidden tokens) and the
 * caller must abort instead of guessing.
 */
export function countEmbedTokens(lines: readonly string[], src: string): number {
	let count = 0;
	for (const _ of matchingTokens(lines, src)) count++;
	return count;
}
