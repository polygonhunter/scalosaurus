/**
 * Live Preview target resolution: map an embed widget's DOM back to the
 * exact document range of its `![[...]]` token.
 *
 * `posAtDOM(embedEl)` returns the widget's own start offset — inherently
 * duplicate-safe (never search by filename: the classic bug class where the
 * wrong occurrence of a twice-embedded image gets rewritten). It throws on
 * detached/recycled widget DOM, hence the guards. The candidate token must
 * additionally match the embed's `src` (see pickLpToken).
 */

import type { EditorView } from "@codemirror/view";
import {
	findEmbedTokens,
	lineLooksLikeTableRow,
	parseEmbed,
	pathMatchesSrc,
	withSize,
	type SizeSpec,
} from "../core/parse";

export interface LpTarget {
	from: number;
	to: number;
	text: string;
	/** Full text of the line containing the token (table-row heuristic). */
	lineText: string;
}

/**
 * LP block widgets (rendered callouts, tables, note embeds): `posAtDOM` on
 * anything inside them only yields the widget's START, so the token cannot
 * be located by position — and a token at column 0 of the first widget line
 * could be hit by mistake. Until real block support lands, embeds inside
 * them are not resolvable (no handles; never a wrong write).
 */
const LP_BLOCK_WIDGET_SELECTOR = ".cm-embed-block, .cm-callout, .cm-table-widget";

export function resolveLpTarget(view: EditorView, embedEl: HTMLElement): LpTarget | null {
	if (!embedEl.isConnected) return null;
	const src = embedEl.getAttribute("src");
	if (!src) return null;
	const widget = embedEl.parentElement?.closest(LP_BLOCK_WIDGET_SELECTOR);
	if (widget && view.dom.contains(widget)) return null;

	let pos: number;
	try {
		pos = view.posAtDOM(embedEl);
	} catch {
		return null;
	}
	if (pos < 0 || pos > view.state.doc.length) return null;

	const line = view.state.doc.lineAt(pos);
	const tokens = findEmbedTokens(line.text).map((token) => ({
		from: line.from + token.start,
		to: line.from + token.end,
		text: token.text,
		lineText: line.text,
	}));
	return pickLpToken(tokens, pos, src);
}

/**
 * Pure token choice for a widget position (unit-tested).
 *
 * Only tokens whose link target matches the embed's `src` are candidates —
 * a neighbouring token for a different image can never be rewritten.
 * Containment: strict (`from <= pos < to`, the normal widget position) or
 * touching the end (`pos == to`, which posAtDOM can report while the token
 * is expanded under the cursor). If that leaves anything but exactly one
 * candidate (e.g. `![[a.png]]![[a.png]]` with pos on the shared border:
 * end of the first or start of the second?) the result is null — abort
 * rather than guess.
 */
export function pickLpToken<T extends { from: number; to: number; text: string }>(
	tokens: readonly T[],
	pos: number,
	src: string,
): T | null {
	const candidates = tokens.filter((t) => {
		const parsed = parseEmbed(t.text);
		return parsed !== null && pathMatchesSrc(parsed, src);
	});
	const strict = candidates.filter((t) => pos >= t.from && pos < t.to);
	const touching = candidates.filter((t) => pos === t.to);
	if (strict.length + touching.length !== 1) return null;
	return strict[0] ?? touching[0] ?? null;
}

export type LpRewritePlan =
	| { kind: "abort" }
	| { kind: "noop" }
	| { kind: "write"; from: number; to: number; insert: string };

/**
 * Pure LP write plan from the target captured at pointerdown and the one
 * re-resolved FRESH at pointerup. The token may legitimately differ (e.g.
 * another actor tweaked the size mid-drag) — but it must still be the same
 * image; the FRESH text is rewritten, never the stale capture.
 */
export function planLpRewrite(
	captured: LpTarget | null,
	fresh: LpTarget | null,
	size: SizeSpec,
	inTable: boolean,
): LpRewritePlan {
	if (!fresh) return { kind: "abort" };
	const freshParsed = parseEmbed(fresh.text);
	if (!freshParsed) return { kind: "abort" };
	if (captured) {
		const capturedParsed = parseEmbed(captured.text);
		if (capturedParsed && capturedParsed.path.trim() !== freshParsed.path.trim()) {
			return { kind: "abort" };
		}
	}
	const insert = withSize(fresh.text, size, {
		escapePipes: freshParsed.escapedPipes || inTable || lineLooksLikeTableRow(fresh.lineText),
	});
	if (insert === null) return { kind: "abort" };
	if (insert === fresh.text) return { kind: "noop" };
	return { kind: "write", from: fresh.from, to: fresh.to, insert };
}
