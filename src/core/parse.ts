/**
 * Pure wikilink-embed token parsing/serialization. No `obsidian` imports —
 * this module is unit-tested directly.
 *
 * Grammar handled: `![[path#subpath|segment|segment|...]]` where any segment
 * may be a size spec. Obsidian's conventions:
 *   - `|300`      → width attribute
 *   - `|300x200`  → width + height attributes
 *   - non-numeric → alt text (the image-captions convention; also where our
 *                   `|100%` / `|fit` sentinel lands)
 * Inside Markdown tables the pipe separator is escaped as `\|` — the parser
 * detects that and round-trips the escaping style.
 */

/** Matches one embed token. `[^[\]]` keeps it from crossing token borders. */
export const EMBED_TOKEN_RE = /!\[\[[^[\]]*?\]\]/g;

/** Segment separator: a pipe, optionally escaped for table contexts. */
const SEPARATOR_RE = /\\?\|/;
const ESCAPED_SEPARATOR_RE = /\\\|/;

/** Sentinel aliases Scalosaurus recognizes as "full column width". */
export const SENTINEL_SEGMENTS = ["100%", "fit"] as const;
export type SentinelToken = (typeof SENTINEL_SEGMENTS)[number];

export type SizeSpec =
	| { kind: "none" }
	| { kind: "width"; width: number }
	| { kind: "width-height"; width: number; height: number }
	| { kind: "sentinel"; token: SentinelToken };

export interface TokenMatch {
	/** Offset of `!` within the searched text. */
	start: number;
	/** Offset just past the closing `]]`. */
	end: number;
	text: string;
}

export interface ParsedEmbed {
	/** Link target as written, including any `#subpath` (untrimmed). */
	path: string;
	/** Non-size alias segments (captions etc.), in original order. */
	segments: string[];
	/** Effective size. When duplicated (`|300|280`), the last one wins. */
	size: SizeSpec;
	/** True when the token used `\|` separators (table context). */
	escapedPipes: boolean;
}

/** Find all embed tokens in a piece of text (usually a single line). */
export function findEmbedTokens(text: string): TokenMatch[] {
	const out: TokenMatch[] = [];
	for (const m of text.matchAll(EMBED_TOKEN_RE)) {
		out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	}
	return out;
}

function classifySegment(segment: string): SizeSpec | null {
	const trimmed = segment.trim();
	// No spaces around the x — matches Obsidian's own syntax; a caption like
	// "8 x 10" must stay a caption, not be consumed as a size.
	const wh = /^(\d+)x(\d+)$/.exec(trimmed);
	if (wh) {
		return {
			kind: "width-height",
			width: parseInt(wh[1] as string, 10),
			height: parseInt(wh[2] as string, 10),
		};
	}
	if (/^\d+$/.test(trimmed)) {
		return { kind: "width", width: parseInt(trimmed, 10) };
	}
	const sentinel = SENTINEL_SEGMENTS.find((s) => s === trimmed);
	if (sentinel) {
		return { kind: "sentinel", token: sentinel };
	}
	return null;
}

/** Parse one embed token (`![[...]]`). Returns null when it isn't one. */
export function parseEmbed(token: string): ParsedEmbed | null {
	if (!token.startsWith("![[") || !token.endsWith("]]")) return null;
	const inner = token.slice(3, -2);
	if (inner.includes("[") || inner.includes("]")) return null;

	const escapedPipes = ESCAPED_SEPARATOR_RE.test(inner);
	const parts = inner.split(SEPARATOR_RE);
	const path = parts[0] ?? "";

	const segments: string[] = [];
	let size: SizeSpec = { kind: "none" };
	for (const part of parts.slice(1)) {
		const classified = classifySegment(part);
		if (classified) {
			// All size-shaped segments are consumed (dedup); the last wins.
			size = classified;
		} else {
			segments.push(part);
		}
	}
	return { path, segments, size, escapedPipes };
}

function sizeSegment(size: SizeSpec): string | null {
	switch (size.kind) {
		case "none":
			return null;
		case "width":
			return String(size.width);
		case "width-height":
			return `${size.width}x${size.height}`;
		case "sentinel":
			return size.token;
	}
}

/** Serialize a parsed embed back to token text. */
export function serializeEmbed(embed: ParsedEmbed): string {
	const sep = embed.escapedPipes ? "\\|" : "|";
	const parts = [embed.path, ...embed.segments];
	const size = sizeSegment(embed.size);
	if (size !== null) parts.push(size);
	return `![[${parts.join(sep)}]]`;
}

export interface WithSizeOptions {
	/** Force `\|` separators (e.g. token sits in a table row). */
	escapePipes?: boolean;
}

/**
 * Replace/insert/remove the size spec of an embed token, preserving path,
 * subpath and caption segments. Returns null when the token can't be parsed.
 */
export function withSize(
	token: string,
	size: SizeSpec,
	options?: WithSizeOptions,
): string | null {
	const parsed = parseEmbed(token);
	if (!parsed) return null;
	parsed.size = size;
	if (options?.escapePipes) parsed.escapedPipes = true;
	return serializeEmbed(parsed);
}

/**
 * Does this token's link target match an embed container's `src` attribute?
 * Obsidian sets `src` to the link target text (path incl. subpath, no size).
 */
export function pathMatchesSrc(parsed: ParsedEmbed, src: string): boolean {
	return parsed.path.trim() === src.trim();
}

/** Leading blockquote/callout markers (`>`, `> >`, `>>`) of a line. */
const BLOCKQUOTE_PREFIX_RE = /^\s*(?:>\s?)*/;

/**
 * Heuristic: is this line a Markdown table row? Used to decide whether a
 * newly inserted pipe separator must be written escaped (`\|`).
 *
 * Blockquote/callout prefixes are stripped first — a table inside a
 * callout (`> | ![[a.png]] | x |`) is still a table. Rows without a
 * leading pipe are deliberately NOT guessed from a bare `|` (prose can
 * contain pipes; an unneeded `\|` outside a table is unverified) — callers
 * OR this with the rendered-DOM signal (`td`/`th`), which catches them.
 */
export function lineLooksLikeTableRow(lineText: string): boolean {
	const trimmed = lineText.replace(BLOCKQUOTE_PREFIX_RE, "").trim();
	return trimmed.startsWith("|") && trimmed.length > 1;
}

/** A GFM delimiter row (`---|:--:`, `| --- | --- |`), blockquote prefix stripped. */
const TABLE_DELIMITER_RE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;

/** Does the line contain a `|` outside `[[...]]` and inline code (blockquote prefix stripped)? */
function hasBarePipe(lineText: string): boolean {
	const body = lineText
		.replace(BLOCKQUOTE_PREFIX_RE, "")
		.replace(/\[\[[^\]]*\]\]/g, "")
		.replace(/`[^`]*`/g, "");
	return body.includes("|");
}

function isTableDelimiterRow(lineText: string): boolean {
	const trimmed = lineText.replace(BLOCKQUOTE_PREFIX_RE, "").trim();
	return trimmed.includes("|") && TABLE_DELIMITER_RE.test(trimmed);
}

/**
 * Source-only table check for paths without a rendered-DOM signal (the
 * editor commands). Catches rows WITHOUT a leading pipe
 * (`a | ![[x.png]]`), which lineLooksLikeTableRow deliberately misses:
 * the line must contain a bare `|` and belong to a contiguous block of
 * pipe lines that has a GFM delimiter row. Prose with a stray `|` has no
 * delimiter row and stays unescaped.
 */
export function lineIsInTable(lines: readonly string[], index: number): boolean {
	const line = lines[index];
	if (line === undefined) return false;
	if (lineLooksLikeTableRow(line)) return true;
	if (!hasBarePipe(line)) return false;
	for (let i = index; i >= 0; i--) {
		const l = lines[i] ?? "";
		if (isTableDelimiterRow(l)) return true;
		if (!hasBarePipe(l)) break;
	}
	for (let i = index + 1; i < lines.length; i++) {
		const l = lines[i] ?? "";
		if (isTableDelimiterRow(l)) return true;
		if (!hasBarePipe(l)) break;
	}
	return false;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Blank out (replace with spaces — offsets stay stable) the parts of the
 * given source lines that Obsidian does NOT render as embeds: fenced code
 * blocks, inline code spans, `%%...%%` comments and `<!-- -->` comments.
 *
 * Why: Reading Mode maps a dragged embed to its source token by counting
 * same-target tokens; a token inside a code span or comment appears in the
 * source but never renders, so counting the raw text would target — and
 * silently rewrite — the wrong token. Scanning masked lines keeps the DOM
 * count and the source count in step. This is an approximation, not a
 * Markdown parser; the occurrence-count cross-check in the Reading Mode
 * commit path turns any residual mismatch into a safe abort.
 */
export function maskNonRenderedText(lines: readonly string[]): string[] {
	let inFence = false;
	let inObsidianComment = false;
	let inHtmlComment = false;

	return lines.map((line) => {
		if (inFence) {
			if (FENCE_RE.test(line)) inFence = false;
			return " ".repeat(line.length);
		}
		if (!inObsidianComment && !inHtmlComment && FENCE_RE.test(line)) {
			inFence = true;
			return " ".repeat(line.length);
		}
		// Fast path: nothing that could open code/comments on this line and
		// no comment state carried in → the line renders as-is.
		if (
			!inObsidianComment &&
			!inHtmlComment &&
			!line.includes("`") &&
			!line.includes("%%") &&
			!line.includes("<!--")
		) {
			return line;
		}

		const out = line.split("");
		// Inline code is line-scoped here (approximation): the run length of
		// the opening backticks must be matched to close.
		let inlineCodeLen = 0;
		let i = 0;
		const mask = (count: number) => {
			for (let k = 0; k < count; k++) out[i + k] = " ";
			i += count;
		};
		const backtickRun = (): number => {
			let run = 0;
			while (line[i + run] === "`") run++;
			return run;
		};

		while (i < line.length) {
			if (inHtmlComment) {
				if (line.startsWith("-->", i)) {
					mask(3);
					inHtmlComment = false;
				} else mask(1);
			} else if (inObsidianComment) {
				if (line.startsWith("%%", i)) {
					mask(2);
					inObsidianComment = false;
				} else mask(1);
			} else if (inlineCodeLen > 0) {
				const run = backtickRun();
				if (run === inlineCodeLen) {
					mask(run);
					inlineCodeLen = 0;
				} else mask(Math.max(run, 1));
			} else if (line.startsWith("<!--", i)) {
				mask(4);
				inHtmlComment = true;
			} else if (line.startsWith("%%", i)) {
				mask(2);
				inObsidianComment = true;
			} else if (line[i] === "`") {
				const run = backtickRun();
				mask(run);
				inlineCodeLen = run;
			} else {
				i++;
			}
		}
		return out.join("");
	});
}

/** File extensions Obsidian renders as image embeds. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "tif", "tiff"];

/** What a link target resolves to, as far as resizing is concerned. */
export type LinkTargetKind = "image" | "excalidraw" | null;

/**
 * Classify a link target by name only (no vault lookup): images by
 * extension, Excalidraw drawings by `.excalidraw` / `.excalidraw.md`.
 * Anything else (note transclusions, PDFs, audio) is null.
 */
export function linkTargetKind(path: string): LinkTargetKind {
	const target = (path.split("#")[0] ?? "").trim().toLowerCase();
	if (target.endsWith(".excalidraw") || target.endsWith(".excalidraw.md")) return "excalidraw";
	const dot = target.lastIndexOf(".");
	if (dot < 0) return null;
	return IMAGE_EXTENSIONS.includes(target.slice(dot + 1)) ? "image" : null;
}

/**
 * The rendered embed token under (or touching) a cursor column, ignoring
 * tokens inside inline code and comments on that line.
 */
export function tokenAtCursor(
	lineText: string,
	ch: number,
	maskedLine?: string,
): TokenMatch | null {
	const masked = maskedLine ?? maskNonRenderedText([lineText])[0] ?? "";
	for (const match of findEmbedTokens(masked)) {
		if (ch >= match.start && ch <= match.end) {
			return { ...match, text: lineText.slice(match.start, match.end) };
		}
	}
	return null;
}

/**
 * The cursor line masked with the context of the lines ABOVE it: a line
 * inside a fenced code block, a multi-line `%%`/`<!-- -->` comment or the
 * YAML frontmatter is blanked entirely (nothing there renders as an embed).
 * `lines` must contain at least lines 0..index.
 */
export function maskedLineInDocument(lines: readonly string[], index: number): string {
	const line = lines[index] ?? "";
	if (index > 0 && lines[0]?.trimEnd() === "---") {
		let close = -1;
		for (let i = 1; i < lines.length && i <= index; i++) {
			const t = lines[i]?.trimEnd();
			if (t === "---" || t === "...") {
				close = i;
				break;
			}
		}
		if (close === -1 || index <= close) return " ".repeat(line.length);
	} else if (index === 0 && line.trimEnd() === "---") {
		return " ".repeat(line.length);
	}
	return maskNonRenderedText(lines.slice(0, index + 1))[index] ?? "";
}

export interface CursorRewrite {
	start: number;
	end: number;
	newToken: string;
}

/**
 * Plan a size rewrite of the token under the cursor. Null when there is no
 * resizable token there or nothing would change. Table rows keep their
 * pipes escaped (`context.inTable` from lineIsInTable covers rows without a
 * leading pipe). `context.maskedLine` (maskedLineInDocument) adds the
 * multi-line code/comment/frontmatter context the single line lacks.
 */
export function planCursorRewrite(
	lineText: string,
	ch: number,
	sizeFor: (kind: Exclude<LinkTargetKind, null>) => SizeSpec | null,
	context?: { inTable?: boolean; maskedLine?: string },
): CursorRewrite | null {
	const token = tokenAtCursor(lineText, ch, context?.maskedLine);
	if (!token) return null;
	const parsed = parseEmbed(token.text);
	if (!parsed) return null;
	const kind = linkTargetKind(parsed.path);
	if (!kind) return null;
	const size = sizeFor(kind);
	if (!size) return null;
	const newToken = withSize(token.text, size, {
		escapePipes: parsed.escapedPipes || context?.inTable === true || lineLooksLikeTableRow(lineText),
	});
	if (newToken === null || newToken === token.text) return null;
	return { start: token.start, end: token.end, newToken };
}
