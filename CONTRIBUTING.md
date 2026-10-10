# Contributing to Scalosaurus

Thanks for your interest in improving Scalosaurus!

## Getting started

```bash
npm install
npm run dev     # watch build into test-vault/.obsidian/plugins/scalosaurus
npm test        # run the vitest suite
npm run lint    # Obsidian store lint (minAppVersion API check included)
npm run build   # type-check + production build (main.js at repo root)
```

Open the bundled `test-vault/` in Obsidian to try the dev build (it is
written straight into the vault's plugin folder). For another vault, copy
`main.js`, `manifest.json` and `styles.css` from a production build into
`<vault>/.obsidian/plugins/scalosaurus/` and reload Obsidian.

## Reporting bugs

Open a GitHub issue with:

- your Obsidian version and platform (desktop/mobile),
- the exact embed link that misbehaves (e.g. `![[img.png|300]]`),
- what you expected and what happened instead.

## Pull requests

- Keep changes focused; one topic per PR.
- `npm run lint`, `npm test` and `npm run build` must pass (CI runs all
  three on pull requests and non-main branches).
- Match the existing code style (tabs, TypeScript strict, no `any` casts).
- Plugin behaviour must follow the
  [Obsidian developer policies](https://docs.obsidian.md/Developer+policies):
  no network calls, no telemetry, edits only ever touch the embed link the
  user resized.

## Releases (maintainers)

Every change merged to `main` carries a patch version bump in
`manifest.json`, `package.json` and `versions.json` (`npm version patch`
updates all three via `version-bump.mjs`). Pushing to `main` triggers the
"Release Obsidian plugin" workflow automatically — it tests, builds,
attests and publishes the GitHub release named after the manifest version.
See `CLAUDE.md` for the full policy.
