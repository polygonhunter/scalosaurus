/**
 * Keyboard path: editor commands that resize the image embed under the
 * cursor (no default hotkeys — users bind their own). The rewrite is a
 * single replaceRange, i.e. one undo step.
 */

import type { Editor, Plugin } from "obsidian";
import { lineIsInTable, maskedLineInDocument, planCursorRewrite, type LinkTargetKind, type SizeSpec } from "./core/parse";
import { sentinelModeFor } from "./core/session";
import type { ScalosaurusSettings } from "./core/settings-model";

type SizeFor = (kind: Exclude<LinkTargetKind, null>) => SizeSpec | null;

/** All lines up to the cursor line plus the contiguous block below it. */
function neighbourLines(editor: Editor, line: number): string[] {
	const lines: string[] = [];
	for (let i = 0; i <= line; i++) lines.push(editor.getLine(i));
	const last = editor.lineCount() - 1;
	for (let i = line + 1; i <= last; i++) {
		const text = editor.getLine(i);
		lines.push(text);
		if (!text.includes("|")) break;
	}
	return lines;
}

function runAtCursor(editor: Editor, checking: boolean, sizeFor: SizeFor): boolean {
	const cursor = editor.getCursor();
	const lineText = editor.getLine(cursor.line);
	// Cheap exit before reading the document: no embed on this line.
	if (!lineText.includes("![[")) return false;
	const lines = neighbourLines(editor, cursor.line);
	const plan = planCursorRewrite(lineText, cursor.ch, sizeFor, {
		// No td/th DOM signal on the keyboard path: detect table rows
		// without a leading pipe from the neighbouring source lines.
		inTable: lineText.includes("|") && lineIsInTable(lines, cursor.line),
		// Code blocks, multi-line comments and frontmatter never render.
		maskedLine: maskedLineInDocument(lines, cursor.line),
	});
	if (!plan) return false;
	if (!checking) {
		editor.replaceRange(
			plan.newToken,
			{ line: cursor.line, ch: plan.start },
			{ line: cursor.line, ch: plan.end },
		);
	}
	return true;
}

export function registerEditorCommands(
	plugin: Plugin,
	getSettings: () => ScalosaurusSettings,
): void {
	plugin.addCommand({
		id: "fit-image-to-column",
		name: "Fit image to column",
		editorCheckCallback: (checking, editor) =>
			runAtCursor(editor, checking, (kind) => {
				const mode = sentinelModeFor(getSettings().sentinelMode, kind);
				// Fixed-pixel mode needs a measured column — only possible
				// with the rendered image (drag or size menu), not here.
				if (mode === "px") return null;
				return { kind: "sentinel", token: mode === "percent" ? "100%" : "fit" };
			}),
	});
	plugin.addCommand({
		id: "reset-image-size",
		name: "Reset image size",
		editorCheckCallback: (checking, editor) =>
			runAtCursor(editor, checking, () => ({ kind: "none" })),
	});
}
