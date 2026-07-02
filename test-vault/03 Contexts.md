# Contexts

Snap must target the **containing block** width, not the global column.

> [!note] Callout
> ![[dino.png|200]]

> Blockquote:
> ![[dino.png|200]]

- List item level 1
    - Nested item with image: ![[dino.png|180]]

Table — pipes must stay escaped (`\|`) after a resize:

| Left | Right |
| ---- | ----- |
| text | ![[dino.png\|150]] |
