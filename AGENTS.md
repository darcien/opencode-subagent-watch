# Development

- Use Bun for dependencies, scripts, builds, and tests. Do not use npm, npx or other package manager.
- Run `bun run precommit` during development and `bun run check` before release.
- Prefer functional, immutable transformations when they improve readability at negligible cost. Keep mutation at stateful I/O boundaries.

## Plugin

- Depend only public API, i.e. `@opencode-ai/plugin/tui`, `@opencode-ai/sdk`, OpenTUI, and Solid APIs. Do not rely on OpenCode internals.
- Default-export `{ id, tui }` from the TUI entry. Do not add a server plugin export.
- Keep runtime diagnostics silent except through `api.client.app.log`; never use `console.log` in plugin code.
- Treat titles as display text only. Use `session.children` and `parentID` for ownership.
- Keep every rendered line bounded by measured terminal display width.

## Packaging

- Publish only `dist` through `exports["./tui"]`.
- Declare only packages imported by built JavaScript as peer dependencies and bundle none of them.
