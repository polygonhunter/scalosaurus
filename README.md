# Scalosaurus

Resize embedded images directly in the editor — with drag handles, an
aspect-ratio lock, snap-to-column-width, and automatic write-back of the
resulting size into the wikilink (`![[image.png|420]]`). Sister plugin of
Linkosaurus.

## Features

- **Drag handles** on hover or tap of any embedded vault image
  (`![[image.png]]`), in **Live Preview and Reading Mode**.
- **Aspect-ratio lock** by default: proportional scaling writes `|W` only
  (Obsidian derives the height). Hold **Shift** (configurable) — even
  mid-drag — to resize freely; that writes `|WxH`.
- **Snap to column width**: near the text column's edge the drag snaps
  (with a visible guide line) and writes the responsive token
  `![[image.png|100%]]`, which this plugin renders at full column width —
  it keeps tracking the column when the window, theme, or readable line
  width changes. Snapping has hysteresis, so the edge doesn't jitter.
- **Safe write-back**: the document is written exactly once, on release —
  a single undo step, no mid-drag flicker. Targeting is position-based
  (never filename search), so the same image embedded twice in one note
  resizes independently. If the note changed under the drag, Scalosaurus
  aborts with a notice rather than guessing.
- **Escape** cancels a drag; **double-click** a handle to remove the size.

## Notes & caveats

- Only vault wikilink embeds (`![[...]]`) are handled — not
  `![](url)`-style or remote images.
- The responsive `|100%` (or `|fit`) token is a Scalosaurus convention.
  Without the plugin, Obsidian shows such images at natural size (the token
  lands in the alt text). Caption plugins may render it as a caption. If
  either bothers you, set **Snapped size format** to *Fixed pixels*.
- Images transcluded via another note (`![[Other note]]`) are deliberately
  left alone — their `![[...]]` token lives in that other file.
- Obsidian 1.12+ ships a native corner-drag in Live Preview. Scalosaurus
  handles take precedence where they appear; see `docs/findings.md` for the
  remaining coexistence work.
- In Reading Mode, edits go through the file atomically (or through an open
  source-mode editor of the same file, keeping them in its undo history).

## Development

```bash
npm install
npm run dev    # watch build straight into test-vault/.obsidian/plugins/scalosaurus
npm test       # unit tests (parser, drag reducer, token locator)
npm run build  # typecheck + production build (main.js at repo root)
```

Open `test-vault/` in Obsidian (with the community plugin
[hot-reload](https://github.com/pjeby/hot-reload) for live reloading). The
vault contains demo notes for duplicates, callouts/tables, transclusions and
edge cases; `docs/findings.md` tracks the empirical M0 verification gates.
