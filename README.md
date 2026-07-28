# pi-footer

A compact two-row footer for [Pi](https://github.com/earendil-works/pi-mono).

```text
~/code/project · trusted
GPT-5.6 Sol · high · 61%/258k · ↑412k ↓18k                 extension status
```

## Features

- Two compact rows that preserve project and model information.
- Current directory and project trust state.
- Model, reasoning effort, context usage, and parent-session input/output tokens.
- Safe, width-bounded rendering of allowed extension statuses.
- Announces its mounted height as `{ rows: 2 }` on `pi-footer:mounted`.
- Defers reload-only mounting by one event-loop turn so Pi can settle its layout.
- No monetary-cost display.

Async subagents and background jobs are intentionally not integrated here. Their activity belongs in [`pi-sidebar`](https://github.com/neumie/pi-sidebar); matching transient status keys are suppressed to avoid duplicate output.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/neumie/pi-footer
```

Then run `/reload` in Pi.

For local development:

```bash
git clone https://github.com/neumie/pi-footer.git
pi install /absolute/path/to/pi-footer
```

Pi packages execute with your full system permissions. Review extension source before installing.

## Development

```bash
npm install
npm run check
```

Requires Node.js 22.19.0 or newer and Pi 0.82.1. The extension is loaded directly from TypeScript; no build step is required.

## Notes

- This extension replaces Pi's complete footer. Another extension calling `ctx.ui.setFooter()` may override it depending on load order.
- It does not call `ctx.ui.setStatus()` or `ctx.ui.setWidget()` and does not subscribe to subagent or background-job events.
- Session token totals come only from assistant messages on the active parent-session branch; legacy subagent snapshot entries are ignored.

## License

[MIT](LICENSE)
