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
- Safe, width-bounded rendering of allowed extension statuses; sidebar activity, MCP/auth, and LSP infrastructure statuses stay hidden.
- Announces its base mounted height as `{ rows: 2 }` on `pi-footer:mounted`.
- Exposes Pi's read-only extension-status map through a versioned, session-scoped capability for `pi-sidebar`.
- Hosts a bounded post-footer composition slot so a compatible narrow sidebar can render below these two rows without taking footer ownership.
- Defers reload-only mounting by one event-loop turn so Pi can settle its layout.
- No monetary-cost display.

Async subagents and background jobs are intentionally not integrated here. Their activity belongs in [`pi-sidebar`](https://github.com/neumie/pi-sidebar); matching transient status keys are suppressed to avoid duplicate output.

## Status-source compatibility seam

Pi 0.82.1 provides extension statuses only to custom footer factories. To let `pi-sidebar` surface actionable infrastructure failures without taking ownership of the footer, `pi-footer` supports this in-process request/replay protocol:

- request: `pi-footer:status-source:v1:request` with `{ version: 1, sessionId }`
- ready: `pi-footer:status-source:v1:ready` with `{ version: 1, sessionId, token, readStatuses }`

`readStatuses()` returns a fresh, bounded array of `{ key, text }` entries. It never exposes Pi's mutable map and returns an empty array after footer disposal or session replacement. Consumers must still validate and sanitize every entry. This temporary seam can disappear once Pi exposes extension statuses outside footer factories.

## Post-footer composition seam

Pi 0.82.1 renders every `belowEditor` widget before the footer and exposes no `belowFooter` placement. To preserve footer ownership while allowing `pi-sidebar` 0.7.0 or newer to put its narrow-bottom shelf last, `pi-footer` publishes a second session-scoped capability:

- request: `pi-footer:post-footer:v1:request` with `{ version: 1, sessionId }`
- ready: `pi-footer:post-footer:v1:ready` with `{ version: 1, sessionId, token, register }`

`register()` accepts a stable id/token, order, row bound, and synchronous width-aware renderer. The footer validates registrations, preserves only safe terminal text and SGR styling, caps all trailing output at 16 rows, isolates renderer failures, and returns a generation-safe handle. Handles become inactive after replacement, footer disposal, or session replacement. The footer still knows nothing about subagents or jobs; the sidebar owns the registered renderer and all activity data.

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
- It does not call `ctx.ui.setStatus()` or `ctx.ui.setWidget()` and does not subscribe to subagent or background-job events. Its event-bus subscriptions only serve status-source and post-footer capability replay requests.
- Session token totals come only from assistant messages on the active parent-session branch; legacy subagent snapshot entries are ignored.

## License

[MIT](LICENSE)
