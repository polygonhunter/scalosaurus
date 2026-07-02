<div align="center">
  <img src="icons/scalosaurus.svg" alt="Scalosaurus" width="112" height="112">
  <h1>Scalosaurus</h1>
  <p><b>Resize embedded images the way you'd expect — by dragging them.</b></p>
</div>

Scalosaurus puts real resize handles on your embedded images, right inside the
editor. Grab a corner, drag to the size you want, and the new dimensions are
written straight back into the wikilink — no more typing `|300` by hand and
eyeballing the result. Drift near your note's text column and the image snaps to
full width, so the size that matters most is one confident drag away.

Sister plugin of **Linkosaurus**. Works in both Live Preview and Reading Mode,
and only ever touches internal `![[image.png]]` embeds.

## Highlights

- **Drag to resize, wherever you edit.** Handles appear on hover or tap, in both
  Live Preview and Reading Mode.
- **Proportions stay intact.** A locked aspect ratio writes a clean `|width` and
  lets Obsidian keep the height; hold **Shift** — even mid-drag — to size freely
  as `|width x height`.
- **Magnetic snap to your column.** Near the text-column edge the drag snaps
  (with a guide line) and writes a responsive `|100%` token that keeps tracking
  the column as the window, theme, or line width changes.
- **Writes once, cleanly.** The link updates on release: a single undo step, no
  flicker, and it targets the exact image you dragged — never a filename guess —
  so the same image embedded twice resizes independently.
- **Stays out of your way.** Escape cancels a drag; double-click a handle to
  clear the size and reset.

## Good to know

- Only vault wikilink embeds (`![[...]]`) are handled — not `![](url)` or remote
  images.
- The responsive `|100%` (or `|fit`) token is a Scalosaurus convention. Without
  the plugin, Obsidian shows the image at its natural size, and some caption
  plugins render the token as a caption. Prefer fixed pixels? Switch **Snapped
  size format** in settings.
- Transcluded images (from `![[Other note]]`) are left alone — their link lives
  in that other file.
- On Obsidian 1.12+, the built-in corner-drag and Scalosaurus coexist; the
  plugin's handles take precedence where they appear.

## Development

```bash
npm install
npm run dev    # watch build straight into test-vault/.obsidian/plugins/scalosaurus
npm test       # unit tests (parser, drag reducer, token locator)
npm run build  # typecheck + production build (main.js at repo root)
```

Open `test-vault/` in Obsidian (with the community plugin
[hot-reload](https://github.com/pjeby/hot-reload) for live reloading). It has
demo notes for duplicates, callouts/tables, transclusions and edge cases;
`docs/findings.md` tracks the empirical M0 verification gates.
