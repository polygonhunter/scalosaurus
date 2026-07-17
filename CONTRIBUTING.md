# Contributing to Scalosaurus

Thanks for your interest in improving Scalosaurus!

## Getting started

```bash
npm install
npm run dev     # watch build (writes main.js)
npm test        # run the vitest suite
npm run build   # type-check + production build
```

To try your build in Obsidian, copy `main.js`, `manifest.json`, and
`styles.css` into `<vault>/.obsidian/plugins/scalosaurus/` (the bundled
`test-vault/` is set up for this) and reload Obsidian.

## Reporting bugs

Open a GitHub issue with:

- your Obsidian version and platform (desktop/mobile),
- the exact embed link that misbehaves (e.g. `![[img.png|300]]`),
- what you expected and what happened instead.

## Pull requests

- Keep changes focused; one topic per PR.
- `npm run build` and `npm test` must pass.
- Match the existing code style (tabs, TypeScript strict, no `any` casts).
- Plugin behaviour must follow the
  [Obsidian developer policies](https://docs.obsidian.md/Developer+policies):
  no network calls, no telemetry, edits only ever touch the embed link the
  user resized.

## Releases (maintainers)

Bump the version in `package.json` (`npm version patch` updates
`manifest.json` and `versions.json` via `version-bump.mjs`), merge to
`main`, then run the "Release Obsidian plugin" workflow — it builds,
attests, and publishes the GitHub release Obsidian ingests.
