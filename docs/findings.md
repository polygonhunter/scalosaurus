# M0 Spike — empirical findings & open gates

Research (2026-07) verified most mechanisms against the Obsidian API, CodeMirror
sources and production plugins, but four facts could only be pinned down
empirically in a real vault on Obsidian ≥ 1.12.4. Each has a **gate**: what to
check, and which knob in the code flips if the assumption fails.

Status legend: ☐ unverified · ☑ verified (fill in date + Obsidian version).

## 1. ☐ `![[img.png|100%]]` — alt attribute vs. parseInt truncation

**Assumption (load-bearing for snap):** a non-numeric size alias lands in the
embed's `alt` attribute in both Live Preview and Reading Mode (premise of the
image-captions ecosystem); Obsidian does **not** truncate `100%` to
`width="100"`.

**Check:** put `![[dino.png|100%]]` in a note. Inspect the embed element
(Ctrl+Shift+I): expected `alt="100%"` and **no** `width` attribute on
`.internal-embed.image-embed` / the inner `img`. Verify in Live Preview *and*
Reading Mode. With the plugin's `styles.css` loaded, the image must track the
column width when resizing the window.

**If it fails:** switch the default sentinel to `fit` — one setting
(`sentinelMode`) and the constants in `src/core/parse.ts`
(`SENTINEL_SEGMENTS`). CSS rules for both tokens already ship.

## 2. ☐ Native 1.12 corner-resize handle — DOM selector

**Assumption:** Obsidian ≥ 1.12 renders its own corner-drag affordance for
images in Live Preview (no setting to disable). Our handles call
`stopPropagation()`/`preventDefault()` on `pointerdown`, which stops the
native drag from starting *on our handles*; elsewhere on the image, native
resize still works.

**Check:** hover an image in Live Preview on 1.12.4+, inspect the corner
affordance DOM, note its class/structure. Then verify: (a) dragging *our*
handles never triggers a native resize; (b) a native resize followed by a
Scalosaurus resize leaves a single, well-formed size segment (parser dedup).

**When pinned:** add a rule under `body.scalosaurus-suppress-native` at the
bottom of `styles.css` hiding the native affordance, wired to the
"Suppress native resize UI" setting (`src/native.ts`).

## 3. ☐ Transclusion nesting — `.markdown-embed` ancestor

**Assumption:** when note A embeds note B and B contains images, those images
render inside a `.internal-embed.markdown-embed` container in A's DOM (both
modes), so `el.closest('.markdown-embed')` detects "this token lives in
another file".

**Check:** note B with an image, note A with `![[B]]`. In A, hover B's image:
Scalosaurus must show **no** handles. Inspect the DOM to confirm the
`.markdown-embed` ancestor exists in both modes.

**If it fails:** tighten the guard in `src/ui/attach.ts` (`isEligibleEmbed`)
with whatever container class the spike reveals.

## 4. ☐ Escaped pipes in tables — `![[img.png\|300]]`

**Assumption:** inside Markdown tables the pipe must be escaped (`\|`);
Obsidian parses `\|` as the size separator there. The parser preserves the
escaping style it found (round-trip), so a resize inside a table keeps `\|`.

**Check:** table cell with `![[dino.png\|150]]`; resize it; the token must
still use `\|` and the table must not break. Also check the native 1.12 bug
(writing a raw `|` into tables) doesn't interleave.

**If it fails:** `src/core/parse.ts` (`parseEmbed`/`serializeEmbed`) owns the
escaping; adjust there. Fallback decision (plan §Edge-Cases): skip resize in
tables with a Notice, defer to v2.

## Also worth recording during the spike

- Exact inner `<img>` attributes for `|300` / `|300x200` (container vs img).
- Whether Reading Mode re-renders the block immediately after `Vault.process`
  (the commit keeps inline styles to avoid a visible snap-back either way).
- Native resize behavior on images that already carry `|100%`.
