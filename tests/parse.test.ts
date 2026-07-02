import { describe, expect, it } from "vitest";
import {
	findEmbedTokens,
	lineLooksLikeTableRow,
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
});
