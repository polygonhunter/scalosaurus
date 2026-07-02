/**
 * Column-width measurement. Measures the embed's actual containing block
 * (content box of its parent) instead of the global `--file-line-width`:
 * themes override the variable, and embeds inside callouts, blockquotes,
 * lists or table cells live in narrower containers — the snap guide and the
 * `|100%` sentinel (CSS `width: 100%`) both resolve against exactly this
 * containing block, so guide, snap and rendering stay consistent.
 *
 * Measured fresh at each drag start — no cache to go stale.
 */

export interface ColumnMetrics {
	/** Available content-box width in px. */
	width: number;
	/** Viewport-relative left/right edges of the content box (guide line). */
	left: number;
	right: number;
}

export function measureContainingBlock(embedEl: HTMLElement): ColumnMetrics | null {
	const parent = embedEl.parentElement;
	if (!parent) return null;
	// ownerDocument.defaultView, not the global window: popout-safe.
	const win = embedEl.ownerDocument?.defaultView;
	if (!win) return null;

	const style = win.getComputedStyle(parent);
	const rect = parent.getBoundingClientRect();
	const paddingLeft = parseFloat(style.paddingLeft) || 0;
	const paddingRight = parseFloat(style.paddingRight) || 0;
	const width = rect.width - paddingLeft - paddingRight;
	if (!(width > 0)) return null;

	return {
		width,
		left: rect.left + paddingLeft,
		right: rect.right - paddingRight,
	};
}
