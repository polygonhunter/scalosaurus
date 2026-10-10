import { describe, expect, it } from "vitest";
import { findEmbedTokens } from "../src/core/parse";
import { pickLpToken, planLpRewrite } from "../src/lp/resolve-lp";

function tokensOf(line: string, lineFrom = 0) {
	return findEmbedTokens(line).map((t) => ({
		from: lineFrom + t.start,
		to: lineFrom + t.end,
		text: t.text,
	}));
}

describe("pickLpToken", () => {
	it("picks the token containing the widget position", () => {
		const tokens = tokensOf("x ![[a.png|200]] y");
		expect(pickLpToken(tokens, 2, "a.png")?.text).toBe("![[a.png|200]]");
		expect(pickLpToken(tokens, 9, "a.png")?.text).toBe("![[a.png|200]]");
	});

	it("accepts pos == to (token expanded under the cursor)", () => {
		const tokens = tokensOf("![[a.png|200]] y");
		expect(pickLpToken(tokens, 14, "a.png")?.text).toBe("![[a.png|200]]");
	});

	it("never returns a token for a different image (src mismatch)", () => {
		const tokens = tokensOf("![[a.png]]");
		expect(pickLpToken(tokens, 0, "b.png")).toBeNull();
	});

	it("resolves adjacent tokens of different images by src", () => {
		// "![[a.png]]" is 10 chars: pos 10 is a.to AND b.from.
		const tokens = tokensOf("![[a.png]]![[b.png]]");
		expect(pickLpToken(tokens, 10, "a.png")?.text).toBe("![[a.png]]");
		expect(pickLpToken(tokens, 10, "b.png")?.text).toBe("![[b.png]]");
	});

	it("returns null for adjacent identical targets on the shared border", () => {
		const tokens = tokensOf("![[a.png]]![[a.png|50]]");
		expect(pickLpToken(tokens, 10, "a.png")).toBeNull();
		// Away from the border it is unambiguous.
		expect(pickLpToken(tokens, 0, "a.png")?.text).toBe("![[a.png]]");
		expect(pickLpToken(tokens, 12, "a.png")?.text).toBe("![[a.png|50]]");
	});

	it("matches subpath targets exactly", () => {
		const tokens = tokensOf("![[a.png#x|10]]");
		expect(pickLpToken(tokens, 0, "a.png#x")?.text).toBe("![[a.png#x|10]]");
		expect(pickLpToken(tokens, 0, "a.png")).toBeNull();
	});

	it("returns null when the position is outside every token", () => {
		const tokens = tokensOf("text ![[a.png]]");
		expect(pickLpToken(tokens, 1, "a.png")).toBeNull();
	});
});

describe("planLpRewrite", () => {
	const target = (text: string, lineText = text) => ({ from: 5, to: 5 + text.length, text, lineText });
	const size = { kind: "width", width: 300 } as const;

	it("writes the fresh token", () => {
		expect(planLpRewrite(target("![[a.png|100]]"), target("![[a.png|120]]"), size, false)).toEqual({
			kind: "write",
			from: 5,
			to: 19,
			insert: "![[a.png|300]]",
		});
	});

	it("aborts when the target vanished or is a different image", () => {
		expect(planLpRewrite(target("![[a.png]]"), null, size, false).kind).toBe("abort");
		expect(planLpRewrite(target("![[a.png]]"), target("![[b.png]]"), size, false).kind).toBe(
			"abort",
		);
	});

	it("is a no-op when nothing changes", () => {
		expect(planLpRewrite(null, target("![[a.png|300]]"), size, false).kind).toBe("noop");
	});

	it("escapes pipes for table rows and the DOM table signal", () => {
		const inRow = planLpRewrite(null, target("![[a.png]]", "| ![[a.png]] |"), size, false);
		expect(inRow).toMatchObject({ insert: "![[a.png\\|300]]" });
		const viaDom = planLpRewrite(null, target("![[a.png]]"), size, true);
		expect(viaDom).toMatchObject({ insert: "![[a.png\\|300]]" });
	});
});
