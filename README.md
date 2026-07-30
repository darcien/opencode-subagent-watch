# opencode-subagent-watch

OpenCode TUI plugin for monitoring subagent activity.

```text
* busy · Locate authentication flow
  explore · grep 8s ago
  run >=2m · $0.14
~ retry · Fix flaky tests
  builder · active
  run 40s
! error · Review patch
  reviewer
  run 43s · $0.03
- idle · Map API routes
  general
  $0.63 · openrouter/deepseek-v3.2
```

Tested with OpenCode 1.18.9.

## Why

I need more visibility when using subagents with OpenCode.
The built-in view is fine when you have only a few short-lived subagents.
But when several are running at once, it is easy to lose track of them.
In my workflow, this often happens when I have multiple reviewers running.

## Local development

Requires:

- [Bun](https://bun.com/)
- [OpenCode](https://opencode.ai/)

Install dependencies and build:

```bash
bun install
bun run build
```

Test the built plugin from either OpenCode config scope:

- Global config: `~/.config/opencode/tui.jsonc`.
- Project config: `.opencode/tui.json`.

Append the absolute path to the `plugin` array:

```json
{
  "plugin": ["/absolute/path/to/opencode-subagent-watch/dist/tui.js"]
}
```

OpenCode loads TUI plugins at startup. Rebuild and restart after each source change:

```bash
bun run build
```

## Checks

- `bun run precommit`: format, lint, typecheck, and test.
- `bun run check`: check formatting, lint, typecheck, test, build, and package.

For plugin load diagnostics:

```bash
opencode --print-logs --log-level DEBUG
```

## Disclaimer

This project is provided as-is, without warranty or guarantee of compatibility, reliability, or continued maintenance. It is not affiliated with or endorsed by OpenCode.

The initial code was generated with GPT-5.6 Sol.

## License

[MIT](LICENSE)
