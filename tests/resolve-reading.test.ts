import { describe, expect, it } from "vitest";
import { locateEmbedToken } from "../src/reading/resolve-reading";

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
});
