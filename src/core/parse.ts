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
	const wh = /^(\d+)\s*x\s*(\d+)$/.exec(trimmed);
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

/**
 * Heuristic: is this line a Markdown table row? Used to decide whether a
 * newly inserted pipe separator must be written escaped (`\|`).
 */
export function lineLooksLikeTableRow(lineText: string): boolean {
	const trimmed = lineText.trim();
	return trimmed.startsWith("|") && trimmed.length > 1;
}
