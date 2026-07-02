# Basics

Plain embed, no size — drag a corner, expect `|W` written on release:

![[dino.png]]

Existing width — resize must replace `300`, single undo step:

![[dino.png|300]]

Existing width×height (unlocked format) — locked drag rewrites to `|W`:

![[dino.png|300x180]]

Sentinel (snap result) — must track the column width when the window resizes:

![[dino.png|100%]]

Caption plus size (image-captions convention) — caption must survive a resize:

![[dino.png|A checkered dinosaur|240]]

Inline with text before ![[tall.png|120]] and after — handles must still work.
