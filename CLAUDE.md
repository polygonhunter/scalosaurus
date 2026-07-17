# Scalosaurus — project rules

## Release policy (MANDATORY)

**Every change — no matter how small — gets a version bump AND a new GitHub
release.** No exceptions: docs, copy, CSS, workflow tweaks, one-liners.

Concretely, every change set MUST, in the same commit:

1. Bump the patch version (e.g. `0.1.7` → `0.1.8`) in **all three** files:
   - `manifest.json` → `version`
   - `package.json` → `version`
   - `versions.json` → add `"<new version>": "<minAppVersion>"`
2. Be pushed to `main`.

Pushing to `main` automatically triggers `.github/workflows/release.yml`,
which builds the plugin and publishes a GitHub release named after the
`manifest.json` version (tag == version, no `v` prefix), with `main.js`,
`manifest.json` and `styles.css` attached plus build provenance attestations.
Never push to `main` without a version bump — the release name comes from the
manifest, and an unchanged version would only refresh the previous release's
assets instead of creating a new release.

After pushing, verify the workflow run succeeded and the release for the new
version exists (assets present) before reporting the work as done.

## Dev commands

```bash
npm install
npm run dev    # watch build into test-vault/.obsidian/plugins/scalosaurus
npm test       # vitest unit tests (parser, drag reducer, token locator)
npm run build  # typecheck + production build (main.js at repo root)
```

## Notes

- The Obsidian community store reads `manifest.json` from the default branch
  and installs assets from the release whose tag equals its `version`.
- `docs/findings.md` tracks the empirical verification gates (M0 spike) for
  assumptions that can only be tested inside a real Obsidian instance.
