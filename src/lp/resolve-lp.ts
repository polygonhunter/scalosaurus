/**
 * Live Preview target resolution: map an embed widget's DOM back to the
 * exact document range of its `![[...]]` token.
 *
 * `posAtDOM(embedEl)` returns the widget's own start offset — inherently
 * duplicate-safe (never search by filename: the classic bug class where the
 * wrong occurrence of a twice-embedded image gets rewritten). It throws on
 * detached/recycled widget DOM, hence the guards.
 */

import type { EditorView } from "@codemirror/view";
import { findEmbedTokens } from "../core/parse";

export interface LpTarget {
	from: number;
	to: number;
	text: string;
	/** Full text of the line containing the token (table-row heuristic). */
	lineText: string;
}

export function resolveLpTarget(view: EditorView, embedEl: HTMLElement): LpTarget | null {
	if (!embedEl.isConnected) return null;
	let pos: number;
	try {
		pos = view.posAtDOM(embedEl);
	} catch {
		return null;
	}
	if (pos < 0 || pos > view.state.doc.length) return null;

	const line = view.state.doc.lineAt(pos);
	for (const token of findEmbedTokens(line.text)) {
		const from = line.from + token.start;
		const to = line.from + token.end;
		if (pos >= from && pos < to) {
			return { from, to, text: token.text, lineText: line.text };
		}
	}
	return null;
}
