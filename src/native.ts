/**
 * Coexistence with Obsidian's native (>= 1.12) corner-drag image resize.
 *
 * v1 strategy: our handles call preventDefault + stopPropagation on
 * pointerdown (ResizeOverlay.startDrag), so the native drag can never start
 * on them; elsewhere on the image the native affordance keeps working.
 * Interleaved native/plugin writes stay well-formed because the parser
 * always rewrites the whole alias with size-segment dedup.
 *
 * The native handle's DOM selector is not pinned yet (docs/findings.md,
 * gate 2). Once known, a rule scoped under this body class in styles.css
 * will hide the native affordance entirely; the class is already toggled by
 * the "Suppress native resize UI" setting so only styles.css needs the
 * follow-up.
 */

export const SUPPRESS_NATIVE_CLASS = "scalosaurus-suppress-native";

export function applyNativeSuppression(doc: Document, enabled: boolean): void {
	doc.body.classList.toggle(SUPPRESS_NATIVE_CLASS, enabled);
}
