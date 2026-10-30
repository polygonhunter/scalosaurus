import { describe, expect, it } from "vitest";
import { maskNonRenderedText } from "../src/core/parse";
import {
	countEmbedTokens,
	linesSource,
	locateEmbedToken,
	planSectionRewrite,
	plannedNoop,
	revertLine,
	scanEmbedTokens,
	sliceLines,
	type SectionRewriteInput,
} from "../src/reading/resolve-reading";

const lines = [
	"# Heading",
	"![[dino.png|200]] ![[dino.png|200]]",
	"text between",
	"![[dino.png|250]]",
	"![[other.png|100]] and ![[dino.png#sec|80]]",
];

describe("locateEmbedToken", () => {
	it("finds the first occurrence", () => {
		const t = locateEmbedToken(lines, "dino.png", 0);
		expect(t).toEqual({ lineOffset: 1, start: 0, end: 17, text: "![[dino.png|200]]" });
	});

	it("disambiguates two identical tokens on one line", () => {
		const t = locateEmbedToken(lines, "dino.png", 1);
		expect(t?.lineOffset).toBe(1);
		expect(t?.start).toBe(18);
	});

	it("counts across lines", () => {
		const t = locateEmbedToken(lines, "dino.png", 2);
		expect(t?.lineOffset).toBe(3);
		expect(t?.text).toBe("![[dino.png|250]]");
	});

	it("matches subpath targets exactly", () => {
		expect(locateEmbedToken(lines, "dino.png#sec", 0)?.lineOffset).toBe(4);
		// plain "dino.png" must NOT match the subpath token
		expect(locateEmbedToken(lines, "dino.png", 3)).toBeNull();
	});

	it("returns null when the occurrence does not exist (note changed)", () => {
		expect(locateEmbedToken(lines, "missing.png", 0)).toBeNull();
		expect(locateEmbedToken(lines, "dino.png", 99)).toBeNull();
	});

	it("handles escaped-pipe tokens in tables", () => {
		const t = locateEmbedToken(["| a | ![[dino.png\\|150]] |"], "dino.png", 0);
		expect(t?.text).toBe("![[dino.png\\|150]]");
	});

	it("skips tokens inside inline code (the wrong-token-write scenario)", () => {
		const line = "Type `![[dino.png]]` to embed it: ![[dino.png]]";
		const t = locateEmbedToken([line], "dino.png", 0);
		expect(t?.start).toBe(line.lastIndexOf("![[dino.png]]"));
	});

	it("skips tokens inside %% comments (commented-out duplicate)", () => {
		const line = "%%![[dino.png|200]]%% here is the real one: ![[dino.png|200]]";
		const t = locateEmbedToken([line], "dino.png", 0);
		expect(t?.start).toBe(line.lastIndexOf("![[dino.png|200]]"));
	});

	it("skips tokens inside fenced code blocks", () => {
		const t = locateEmbedToken(
			["```", "![[dino.png]]", "```", "![[dino.png]]"],
			"dino.png",
			0,
		);
		expect(t?.lineOffset).toBe(3);
	});
});

describe("countEmbedTokens", () => {
	it("counts only rendered tokens", () => {
		expect(
			countEmbedTokens(
				[
					"Type `![[dino.png]]` here: ![[dino.png]]",
					"%%![[dino.png]]%%",
					"![[dino.png]] and ![[other.png]]",
				],
				"dino.png",
			),
		).toBe(2);
	});

	it("returns 0 for markdown-syntax images (no wikilink token)", () => {
		expect(countEmbedTokens(["![alt](dino.png)"], "dino.png")).toBe(0);
	});
});

describe("scanEmbedTokens", () => {
	it("counts and locates in one pass", () => {
		const scan = scanEmbedTokens(lines, "dino.png", 2);
		expect(scan.count).toBe(3);
		expect(scan.located?.text).toBe("![[dino.png|250]]");
	});

	it("reports located = null for a missing occurrence but still counts", () => {
		const scan = scanEmbedTokens(lines, "dino.png", 7);
		expect(scan.count).toBe(3);
		expect(scan.located).toBeNull();
	});
});

describe("maskNonRenderedText fast path", () => {
	it("returns plain lines unchanged (identity) and still tracks comment state", () => {
		const plain = "![[a.png]] plain text";
		const masked = maskNonRenderedText([plain, "%% open", "![[a.png]] hidden", "close %%", plain]);
		expect(masked[0]).toBe(plain);
		expect(masked[2]?.trim()).toBe("");
		expect(masked[4]).toBe(plain);
	});

	it("still masks inside an open fence", () => {
		const masked = maskNonRenderedText(["~~~", "![[a.png]]", "~~~", "![[a.png]]"]);
		expect(masked[1]?.trim()).toBe("");
		expect(masked[3]).toBe("![[a.png]]");
	});
});

describe("sliceLines", () => {
	const text = "l0\nl1\nl2\nl3";
	it("returns the inclusive window", () => {
		expect(sliceLines(text, 1, 2)).toEqual(["l1", "l2"]);
		expect(sliceLines(text, 0, 0)).toEqual(["l0"]);
		expect(sliceLines(text, 3, 3)).toEqual(["l3"]);
		expect(sliceLines(text, 0, 3)).toEqual(["l0", "l1", "l2", "l3"]);
	});

	it("matches split() incl. a trailing newline", () => {
		const t = "a\nb\n";
		expect(sliceLines(t, 2, 2)).toEqual(t.split("\n").slice(2, 3));
	});

	it("returns null when the window does not fit", () => {
		expect(sliceLines(text, 3, 4)).toBeNull();
		expect(sliceLines(text, 5, 5)).toBeNull();
		expect(sliceLines(text, -1, 0)).toBeNull();
		expect(sliceLines(text, 2, 1)).toBeNull();
	});
});

describe("planSectionRewrite", () => {
	const file = ["# Title", "", "![[a.png|100]] and ![[a.png]]", "after"];
	const base: SectionRewriteInput = {
		lineStart: 2,
		lineEnd: 2,
		renderLines: ["![[a.png|100]] and ![[a.png]]"],
		src: "a.png",
		occurrence: 1,
		domCount: 2,
		size: { kind: "width", width: 300 },
		inTable: false,
	};

	it("writes the size first for Excalidraw embeds", () => {
		const lines = ["![[d|200|left-wrap]]"];
		const plan = planSectionRewrite(linesSource(lines), {
			...base,
			lineStart: 0,
			lineEnd: 0,
			renderLines: lines,
			src: "d",
			occurrence: 0,
			domCount: 1,
			sizeFirst: true,
		});
		expect(plan?.newToken).toBe("![[d|300|left-wrap]]");
	});

	it("plans a rewrite of the right occurrence", () => {
		const plan = planSectionRewrite(linesSource(file), base);
		expect(plan).toEqual({
			line: 2,
			start: 19,
			end: 29,
			oldToken: "![[a.png]]",
			newToken: "![[a.png|300]]",
		});
	});

	it("aborts on a stale line window (section text changed)", () => {
		const edited = [...file];
		edited[2] = "![[a.png|100]] and ![[a.png]] edited";
		expect(planSectionRewrite(linesSource(edited), base)).toBeNull();
		// Lines shifted by an insert above the section.
		expect(planSectionRewrite(linesSource(["new", ...file]), base)).toBeNull();
	});

	it("aborts on a count mismatch (DOM vs source)", () => {
		expect(planSectionRewrite(linesSource(file), { ...base, domCount: 3 })).toBeNull();
	});

	it("aborts when the file got shorter than the window", () => {
		expect(planSectionRewrite(linesSource(file.slice(0, 2)), base)).toBeNull();
	});

	it("aborts on a render-window length mismatch", () => {
		expect(
			planSectionRewrite(linesSource(file), { ...base, renderLines: ["x", "y"] }),
		).toBeNull();
	});

	it("escapes the pipe in table rows (source heuristic and DOM signal)", () => {
		const table = ["| x | ![[a.png]] |"];
		const plan = planSectionRewrite(linesSource(table), {
			...base,
			lineStart: 0,
			lineEnd: 0,
			renderLines: table,
			occurrence: 0,
			domCount: 1,
		});
		expect(plan?.newToken).toBe("![[a.png\\|300]]");
		const headless = ["![[a.png]] | x"];
		const viaDom = planSectionRewrite(linesSource(headless), {
			...base,
			lineStart: 0,
			lineEnd: 0,
			renderLines: headless,
			occurrence: 0,
			domCount: 1,
			inTable: true,
		});
		expect(viaDom?.newToken).toBe("![[a.png\\|300]]");
	});

	it("reports a no-op when the size is unchanged", () => {
		const plan = planSectionRewrite(linesSource(file), {
			...base,
			occurrence: 0,
			size: { kind: "width", width: 100 },
		});
		expect(plan && plannedNoop(plan)).toBe(true);
	});

	it("reads only the section window from the source", () => {
		const read: number[] = [];
		const source = {
			lineCount: () => file.length,
			getLine: (i: number) => {
				read.push(i);
				return file[i] as string;
			},
		};
		planSectionRewrite(source, base);
		expect(read).toEqual([2]);
	});
});

describe("planSectionRewrite with CRLF line endings", () => {
	const crlf = "# T\r\n\r\n![[a.png|100]]\r\nafter\r\n";
	const renderLines = sliceLines(crlf, 2, 2) ?? [];
	const input: SectionRewriteInput = {
		lineStart: 2,
		lineEnd: 2,
		renderLines,
		src: "a.png",
		occurrence: 0,
		domCount: 1,
		size: { kind: "width", width: 300 },
		inTable: false,
	};

	it("matches editor lines (no \\r) against CRLF render lines", () => {
		expect(renderLines).toEqual(["![[a.png|100]]\r"]);
		const editorLines = crlf.replace(/\r/g, "").split("\n");
		const plan = planSectionRewrite(linesSource(editorLines), input);
		expect(plan).toMatchObject({ line: 2, start: 0, end: 14, newToken: "![[a.png|300]]" });
	});

	it("keeps the \\r when rewriting raw file data", () => {
		const lines = crlf.split("\n");
		const plan = planSectionRewrite(linesSource(lines), input);
		expect(plan).not.toBeNull();
		if (!plan) return;
		const line = lines[plan.line] as string;
		const rewritten = line.slice(0, plan.start) + plan.newToken + line.slice(plan.end);
		expect(rewritten).toBe("![[a.png|300]]\r");
	});

	it("still aborts when the content (not just the line ending) differs", () => {
		const editorLines = ["# T", "", "![[a.png|120]]", "after"];
		expect(planSectionRewrite(linesSource(editorLines), input)).toBeNull();
	});
});

describe("revertLine", () => {
	const plan = { line: 0, start: 2, end: 12, oldToken: "![[a.png]]", newToken: "![[a.png|300]]" };

	it("restores the old token when the new one is still in place", () => {
		expect(revertLine("x ![[a.png|300]] y", plan)).toBe("x ![[a.png]] y");
	});

	it("refuses when the line changed meanwhile", () => {
		expect(revertLine("x ![[a.png|320]] y", plan)).toBeNull();
		expect(revertLine("xx ![[a.png|300]] y", plan)).toBeNull();
		expect(revertLine(undefined, plan)).toBeNull();
	});
});
