# Edge cases

Tiny image — handles must not overlap into an unusable blob (min width 32px):

![[tiny.png]]

SVG without intrinsic size (`naturalWidth` may be 0) — aspect lock must fall
back to the rendered rect, no NaN:

![[vector.svg|200]]

Portrait image — aspect lock sanity:

![[tall.png|150]]

Heading subpath embed (not an image — must be ignored entirely):

![[01 Basics#Basics]]
