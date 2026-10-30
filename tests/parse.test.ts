import { describe, expect, it } from "vitest";
import {
	findEmbedTokens,
	lineLooksLikeTableRow,
	lineIsInTable,
	maskedLineInDocument,
	linkTargetKind,
	planCursorRewrite,
	tokenAtCursor,
	maskNonRenderedText,
	needsEscapedPipes,
	parseEmbed,
	pathMatchesSrc,
	serializeEmbed,
	withSize,
} from "../src/core/parse";

describe("findEmbedTokens", () => {
	it("finds multiple tokens with correct offsets", () => {
		const line = "before ![[a.png|200]] mid ![[b.png]] after";
		const tokens = findEmbedTokens(line);
		expect(tokens).toHaveLength(2);
		expect(tokens[0]).toEqual({ start: 7, end: 21, text: "![[a.png|200]]" });
		expect(line.slice(tokens[1]!.start, tokens[1]!.end)).toBe("![[b.png]]");
	});

	it("does not merge adjacent tokens", () => {
		const tokens = findEmbedTokens("![[a.png|100]] ![[a.png|100]]");
		expect(tokens).toHaveLength(2);
	});

	it("ignores non-embed wikilinks", () => {
		expect(findEmbedTokens("a [[b.png]] c")).toHaveLength(0);
	});
});

describe("parseEmbed", () => {
	it("parses a plain embed", () => {
		expect(parseEmbed("![[img.png]]")).toEqual({
			path: "img.png",
			segments: [],
			size: { kind: "none" },
			escapedPipes: false,
		});
	});

	it("parses width", () => {
		expect(parseEmbed("![[img.png|300]]")?.size).toEqual({ kind: "width", width: 300 });
	});

	it("parses width x height", () => {
		expect(parseEmbed("![[img.png|300x200]]")?.size).toEqual({
			kind: "width-height",
			width: 300,
			height: 200,
		});
	});

	it("parses the 100% sentinel", () => {
		expect(parseEmbed("![[img.png|100%]]")?.size).toEqual({ kind: "sentinel", token: "100%" });
	});

	it("parses the fit sentinel", () => {
		expect(parseEmbed("![[img.png|fit]]")?.size).toEqual({ kind: "sentinel", token: "fit" });
	});

	it("keeps captions and subpaths, last size wins (dedup)", () => {
		const parsed = parseEmbed("![[img.png#section|A caption|300|280]]");
		expect(parsed).toEqual({
			path: "img.png#section",
			segments: ["A caption"],
			size: { kind: "width", width: 280 },
			escapedPipes: false,
		});
	});

	it("treats a caption that merely contains digits as caption", () => {
		const parsed = parseEmbed("![[img.png|scaled to 100%]]");
		expect(parsed?.segments).toEqual(["scaled to 100%"]);
		expect(parsed?.size).toEqual({ kind: "none" });
	});

	it("does not consume spaced captions like '8 x 10' as a size", () => {
		const parsed = parseEmbed("![[img.png|8 x 10]]");
		expect(parsed?.segments).toEqual(["8 x 10"]);
		expect(parsed?.size).toEqual({ kind: "none" });
		// ...and a resize must keep the caption:
		expect(withSize("![[img.png|8 x 10]]", { kind: "width", width: 300 })).toBe(
			"![[img.png|8 x 10|300]]",
		);
	});

	it("detects escaped pipes (table context)", () => {
		const parsed = parseEmbed("![[img.png\\|150]]");
		expect(parsed?.escapedPipes).toBe(true);
		expect(parsed?.size).toEqual({ kind: "width", width: 150 });
	});

	it("rejects non-embeds", () => {
		expect(parseEmbed("[[img.png]]")).toBeNull();
		expect(parseEmbed("![](img.png)")).toBeNull();
	});
});

describe("serializeEmbed / withSize round-trips", () => {
	const roundtrip = (token: string) => serializeEmbed(parseEmbed(token)!);

	it("round-trips plain, width, WxH, sentinel", () => {
		for (const token of [
			"![[img.png]]",
			"![[img.png|300]]",
			"![[img.png|300x200]]",
			"![[img.png|100%]]",
			"![[img.png#head|cap|240]]",
		]) {
			expect(roundtrip(token)).toBe(token);
		}
	});

	it("round-trips escaped pipes", () => {
		expect(roundtrip("![[img.png\\|150]]")).toBe("![[img.png\\|150]]");
	});

	it("normalizes duplicated sizes on round-trip", () => {
		expect(roundtrip("![[img.png|300|280]]")).toBe("![[img.png|280]]");
	});

	it("withSize replaces an existing width", () => {
		expect(withSize("![[img.png|300]]", { kind: "width", width: 420 })).toBe("![[img.png|420]]");
	});

	it("withSize adds a width where none existed", () => {
		expect(withSize("![[img.png]]", { kind: "width", width: 420 })).toBe("![[img.png|420]]");
	});

	it("withSize switches px to sentinel and keeps the caption", () => {
		expect(
			withSize("![[img.png|My caption|300]]", { kind: "sentinel", token: "100%" }),
		).toBe("![[img.png|My caption|100%]]");
	});

	it("withSize removes the size entirely (double-click reset)", () => {
		expect(withSize("![[img.png|300x200]]", { kind: "none" })).toBe("![[img.png]]");
	});

	it("withSize puts the size first for Excalidraw (style class survives)", () => {
		const w400 = { kind: "width", width: 400 } as const;
		const first = { sizeFirst: true };
		// Excalidraw reads `|size|style`; a style before the size is lost.
		expect(withSize("![[d.excalidraw|300|left-wrap]]", w400, first)).toBe(
			"![[d.excalidraw|400|left-wrap]]",
		);
		expect(withSize("![[d.excalidraw|left-wrap|300]]", w400, first)).toBe(
			"![[d.excalidraw|400|left-wrap]]",
		);
		expect(withSize("![[d.excalidraw|left-wrap]]", w400, first)).toBe(
			"![[d.excalidraw|400|left-wrap]]",
		);
		expect(
			withSize("![[d\\|300\\|left-wrap]]", { kind: "sentinel", token: "100%" }, first),
		).toBe("![[d\\|100%\\|left-wrap]]");
		expect(withSize("![[d|300|left-wrap]]", { kind: "none" }, first)).toBe(
			"![[d|left-wrap]]",
		);
	});

	it("withSize keeps table escaping", () => {
		expect(withSize("![[img.png\\|150]]", { kind: "width", width: 200 })).toBe(
			"![[img.png\\|200]]",
		);
	});

	it("withSize can force escaping for new sizes in tables", () => {
		expect(
			withSize("![[img.png]]", { kind: "width", width: 200 }, { escapePipes: true }),
		).toBe("![[img.png\\|200]]");
	});

	it("withSize returns null for garbage", () => {
		expect(withSize("not a token", { kind: "none" })).toBeNull();
	});
});

describe("pathMatchesSrc", () => {
	it("matches trimmed link targets", () => {
		expect(pathMatchesSrc(parseEmbed("![[ img.png |300]]")!, "img.png")).toBe(true);
		expect(pathMatchesSrc(parseEmbed("![[img.png#sec|300]]")!, "img.png#sec")).toBe(true);
		expect(pathMatchesSrc(parseEmbed("![[other.png]]")!, "img.png")).toBe(false);
	});
});

describe("lineLooksLikeTableRow", () => {
	it("detects table rows", () => {
		expect(lineLooksLikeTableRow("| a | ![[x.png\\|1]] |")).toBe(true);
		expect(lineLooksLikeTableRow("  | a | b |")).toBe(true);
		expect(lineLooksLikeTableRow("plain ![[x.png]]")).toBe(false);
		expect(lineLooksLikeTableRow("|")).toBe(false);
	});

	it("detects table rows inside callouts and blockquotes", () => {
		expect(lineLooksLikeTableRow("> | ![[a.png]] | x |")).toBe(true);
		expect(lineLooksLikeTableRow(">| ![[a.png]] | x |")).toBe(true);
		expect(lineLooksLikeTableRow("> > | ![[a.png]] | x |")).toBe(true);
		expect(lineLooksLikeTableRow(">> | a | b |")).toBe(true);
		expect(lineLooksLikeTableRow("> ![[a.png]] quoted")).toBe(false);
		expect(lineLooksLikeTableRow("> [!note] title")).toBe(false);
		expect(lineLooksLikeTableRow("> |")).toBe(false);
	});

	it("does not guess from a bare pipe in prose (DOM signal covers headless rows)", () => {
		expect(lineLooksLikeTableRow("![[a.png]] | x")).toBe(false);
		expect(lineLooksLikeTableRow("either A | B ![[a.png]]")).toBe(false);
	});
});

describe("maskNonRenderedText", () => {
	it("preserves line lengths and offsets", () => {
		const lines = ["Type `![[a.png]]` then ![[a.png]]"];
		const masked = maskNonRenderedText(lines);
		expect(masked[0]).toHaveLength(lines[0]!.length);
	});

	it("masks inline code but keeps the real token findable at its offset", () => {
		const line = "Type `![[a.png]]` to embed it: ![[a.png]]";
		const masked = maskNonRenderedText([line])[0]!;
		const tokens = findEmbedTokens(masked);
		expect(tokens).toHaveLength(1);
		expect(line.slice(tokens[0]!.start, tokens[0]!.end)).toBe("![[a.png]]");
		expect(tokens[0]!.start).toBe(line.lastIndexOf("![[a.png]]"));
	});

	it("masks single-line %% comments", () => {
		const line = "%%![[a.png|200]]%% real: ![[a.png|200]]";
		const masked = maskNonRenderedText([line])[0]!;
		expect(findEmbedTokens(masked)).toHaveLength(1);
		expect(masked.indexOf("real:")).toBe(line.indexOf("real:"));
	});

	it("masks multi-line %% comments", () => {
		const masked = maskNonRenderedText(["before %%", "![[a.png]]", "%% after ![[b.png]]"]);
		expect(findEmbedTokens(masked[1]!)).toHaveLength(0);
		expect(findEmbedTokens(masked[2]!)).toHaveLength(1);
	});

	it("masks fenced code blocks including indented fences", () => {
		const masked = maskNonRenderedText([
			"![[a.png]]",
			"```md",
			"![[a.png]]",
			"```",
			"  ~~~",
			"![[a.png]]",
			"  ~~~",
			"![[a.png]]",
		]);
		const counts = masked.map((l) => findEmbedTokens(l).length);
		expect(counts).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
	});

	it("masks HTML comments across lines", () => {
		const masked = maskNonRenderedText(["a <!-- ![[a.png]]", "![[a.png]] --> ![[a.png]]"]);
		expect(findEmbedTokens(masked[0]!)).toHaveLength(0);
		expect(findEmbedTokens(masked[1]!)).toHaveLength(1);
	});

	it("does not mask regular text", () => {
		const lines = ["plain ![[a.png|300]] text"];
		expect(maskNonRenderedText(lines)).toEqual(lines);
	});
});

describe("linkTargetKind", () => {
	it("classifies by name", () => {
		expect(linkTargetKind("a.png")).toBe("image");
		expect(linkTargetKind("folder/Photo.JPEG#x")).toBe("image");
		expect(linkTargetKind("Drawing.excalidraw")).toBe("excalidraw");
		expect(linkTargetKind("Drawing.excalidraw.md")).toBe("excalidraw");
		expect(linkTargetKind("Some note")).toBeNull();
		expect(linkTargetKind("Some note#Heading")).toBeNull();
		expect(linkTargetKind("paper.pdf")).toBeNull();
	});
});

describe("tokenAtCursor / planCursorRewrite", () => {
	const fit = () => ({ kind: "sentinel", token: "100%" }) as const;

	it("finds the token under or touching the cursor", () => {
		const line = "x ![[a.png|200]] y";
		expect(tokenAtCursor(line, 2)?.text).toBe("![[a.png|200]]");
		expect(tokenAtCursor(line, 16)?.text).toBe("![[a.png|200]]");
		expect(tokenAtCursor(line, 0)).toBeNull();
	});

	it("ignores tokens in inline code", () => {
		expect(tokenAtCursor("`![[a.png]]`", 3)).toBeNull();
	});

	it("rewrites the size of an image token", () => {
		expect(planCursorRewrite("![[a.png|200]]", 3, fit)).toEqual({
			start: 0,
			end: 14,
			newToken: "![[a.png|100%]]",
		});
		expect(planCursorRewrite("![[a.png|200]]", 3, () => ({ kind: "none" }))?.newToken).toBe(
			"![[a.png]]",
		);
	});

	it("escapes pipes in table rows", () => {
		expect(planCursorRewrite("| ![[a.png]] |", 4, fit)?.newToken).toBe("![[a.png\\|100%]]");
	});

	it("skips note transclusions and no-ops", () => {
		expect(planCursorRewrite("![[Some note]]", 3, fit)).toBeNull();
		expect(planCursorRewrite("![[a.png|100%]]", 3, fit)).toBeNull();
		expect(planCursorRewrite("![[a.png]]", 3, () => null)).toBeNull();
	});
});

describe("lineIsInTable (keyboard path, no DOM signal)", () => {
	it("detects rows without a leading pipe via the delimiter row", () => {
		const doc = ["a | b", "--- | ---", "x | ![[x.png]]"];
		expect(lineIsInTable(doc, 2)).toBe(true);
		expect(lineIsInTable(doc, 0)).toBe(true);
		expect(lineIsInTable(["![[a.png]] | text", "---|---"], 0)).toBe(true);
	});

	it("detects rows without a leading pipe inside a callout", () => {
		const doc = ["> [!note]", "> a | b", "> :--|--:", "> ![[a.png]] | x"];
		expect(lineIsInTable(doc, 3)).toBe(true);
	});

	it("leaves prose with a stray pipe alone", () => {
		expect(lineIsInTable(["either A | B ![[a.png]]"], 0)).toBe(false);
		expect(lineIsInTable(["text", "", "a | ![[x.png]]", "", "---"], 2)).toBe(false);
		// Only the pipe inside the wikilink — not a table row.
		expect(lineIsInTable(["![[a.png|200]]", "---|---"], 0)).toBe(false);
	});

	it("feeds planCursorRewrite so the inserted pipe is escaped", () => {
		const fit = () => ({ kind: "sentinel", token: "100%" }) as const;
		const doc = ["a | b", "--- | ---", "a | ![[x.png]]"];
		expect(
			planCursorRewrite(doc[2]!, 6, fit, { inTable: lineIsInTable(doc, 2) })?.newToken,
		).toBe("![[x.png\\|100%]]");
	});
});

describe("needsEscapedPipes", () => {
	const parsed = (token: string) => parseEmbed(token)!;

	it("escapes when the token, the caller or the line says table", () => {
		expect(needsEscapedPipes(parsed("![[a.png\\|1]]"), "x", false)).toBe(true);
		expect(needsEscapedPipes(parsed("![[a.png]]"), "x", true)).toBe(true);
		expect(needsEscapedPipes(parsed("![[a.png]]"), "| ![[a.png]] |", false)).toBe(true);
		expect(needsEscapedPipes(parsed("![[a.png]]"), "text ![[a.png]]", false)).toBe(false);
	});
});

describe("planCursorRewrite for Excalidraw", () => {
	it("writes the size as the first alias segment", () => {
		const w = () => ({ kind: "width", width: 400 }) as const;
		const line = "![[sketch.excalidraw|left-wrap]]";
		expect(planCursorRewrite(line, 3, w)?.newToken).toBe("![[sketch.excalidraw|400|left-wrap]]");
	});
});

describe("maskedLineInDocument (keyboard path, multi-line context)", () => {
	const fit = () => ({ kind: "sentinel", token: "100%" }) as const;
	const plan = (doc: string[], line: number, ch: number) =>
		planCursorRewrite(doc[line]!, ch, fit, { maskedLine: maskedLineInDocument(doc, line) });

	it("ignores embeds inside fenced code blocks", () => {
		const doc = ["text", "```", "![[a.png]]", "```", "![[a.png]]"];
		expect(plan(doc, 2, 3)).toBeNull();
		expect(plan(doc, 4, 3)?.newToken).toBe("![[a.png|100%]]");
	});

	it("ignores embeds inside multi-line %% and HTML comments", () => {
		expect(plan(["%%", "![[a.png]]", "%%"], 1, 3)).toBeNull();
		expect(plan(["<!--", "![[a.png]]", "-->"], 1, 3)).toBeNull();
	});

	it("ignores the YAML frontmatter but not the body", () => {
		const doc = ["---", "cover: ![[a.png]]", "---", "![[a.png]]"];
		expect(plan(doc, 1, 9)).toBeNull();
		expect(plan(doc, 3, 3)?.newToken).toBe("![[a.png|100%]]");
		// A thematic break later in the body is not frontmatter.
		expect(plan(["![[a.png]]", "---"], 0, 3)?.newToken).toBe("![[a.png|100%]]");
	});
});
