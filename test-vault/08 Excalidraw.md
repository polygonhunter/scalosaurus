# Excalidraw embeds

Requires the Excalidraw plugin (not bundled with this test vault). Create a
drawing named `sketch` and embed it here — handles must appear, a drag must
rewrite the token, and a snapped drag must write `|100%` (Excalidraw parses it
natively; `|fit` is mapped to `|100%`):

![[sketch|400]]

A style class must survive a resize — the size stays the FIRST segment
(`|400|left-wrap`, never `|left-wrap|400`, which Excalidraw would misread):

![[sketch|400|left-wrap]]

A drawing inside a transcluded note must still get NO handles (its token
lives in the other file).
