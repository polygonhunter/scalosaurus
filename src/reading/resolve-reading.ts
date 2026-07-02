/**
 * Pure token location for Reading Mode. Given the source lines of a section
 * (from `getSectionInfo`) and the embed's `src` attribute, find the N-th
 * token whose link target matches — mirroring how the caller counted the
 * embed's index among same-src `.image-embed` elements in the section DOM.
 * No `obsidian` imports — unit-tested directly.
 */

import { findEmbedTokens, parseEmbed, pathMatchesSrc } from "../core/parse";

export interface LocatedToken {
	/** 0-based index into the passed `lines` array. */
	lineOffset: number;
	/** Char offsets within that line. */
	start: number;
	end: number;
	text: string;
}

/**
 * Find the `occurrence`-th (0-based) embed token with link target `src`
 * within `lines`. Returns null when there is no such occurrence — callers
 * must treat that as "note changed, do not write".
 */
export function locateEmbedToken(
	lines: readonly string[],
	src: string,
	occurrence: number,
): LocatedToken | null {
	let seen = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		for (const match of findEmbedTokens(line)) {
			const parsed = parseEmbed(match.text);
			if (!parsed || !pathMatchesSrc(parsed, src)) continue;
			if (seen === occurrence) {
				return { lineOffset: i, start: match.start, end: match.end, text: match.text };
			}
			seen++;
		}
	}
	return null;
}
