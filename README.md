# opencode-sessions-sidebar

A [OpenCode](https://opencode.ai) TUI plugin that adds a persistent sidebar section
showing **all sessions from the last 7 days across every project** — scrollable,
with live updates as sessions change.

## What it shows

- `SESSIONS · 7D (N)` header
- Per session, two lines (grouped with blank separators):
  - **Digest** — session title, falling back to the first user message or project name
  - **Full session id** (`ses_…`, 30 chars) — copy-paste ready for `sessions_read` / `sessions_rename`
- Scroll with `ctrl+↑↓` or mouse wheel
- Fixed-height list (12 rows by default, scrolls internally); colors follow the host theme

## Requirements

- OpenCode v2.1.4+ (TUI with `sidebar.content` slot support)
- Bun runtime (the host's embedded Bun resolves `bun:sqlite`)

## Install

Clone this repo into your opencode config directory:

```sh
git clone https://github.com/HaiwenLi/opencode-sessions-sidebar.git \
  ~/.config/opencode/tui-plugins/opencode-sessions-sidebar
```

No `npm install` needed — the host rewrites `solid-js` / `@opentui/*` to its own
instances, and the repo does not vendor `node_modules`.

## Register the plugin

Add the plugin path (relative to your opencode config) to the `plugins` array in
`~/.config/opencode/cli.json`:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "./tui-plugins/opencode-sessions-sidebar"
  ]
}
```

> Keep it in the **CLI config** (`cli.json`). The server config (`opencode.jsonc`)
> does not read the `plugins` key.

Then start `opencode` (TUI) — you should see `SESSIONS · 7D` in the right sidebar,
below the built-in Context / MCP sections.

## Configuration (optional)

Defaults reproduce the verified layout — nothing to set. Installs differ
(machine, terminal size, opencode version), so every knob has an env override:

| Env | Default | Purpose |
| --- | --- | --- |
| `SESSIONS_SIDEBAR_DAYS` | `7` | Lookback window in days |
| `SESSIONS_SIDEBAR_MAX` | `200` | Max sessions queried |
| `SESSIONS_SIDEBAR_HEIGHT` | `12` | Visible list rows (scrolls internally) |
| `SESSIONS_SIDEBAR_WIDTH` | auto | Text columns for clipping. Auto-detected from the sidebar's real width; setting it pins the value |
| `SESSIONS_SIDEBAR_DB` | auto | Explicit `opencode.db` path (skips discovery — portable/symlinked/second installs) |

Data-layer robustness across machines is automatic:

- The DB is discovered via `XDG_DATA_HOME`, then `HOME` / `USERPROFILE` /
  `os.homedir()` → `~/.local/share/opencode/opencode.db`.
- A DB storing `time_updated` in unix seconds (older opencode builds) is
  detected automatically, so the lookback window never silently empties.
- A machine with no DB yet (fresh install) shows an actionable hint instead
  of a raw sqlite error.

## Updating an existing install

```sh
git -C ~/.config/opencode/tui-plugins/opencode-sessions-sidebar pull --ff-only
```

Then restart the TUI. On every machine the workflow is the same: clone once,
register in `cli.json` once, `git pull` to update — the `plugins` entry lives
in per-machine config and survives plugin updates.

## Verify it loaded

Run opencode with debug logging and check the load chain:

```
stage=read entrypoint=…/tui-plugins/opencode-sessions-sidebar/tui.js
stage=setup plugin=sessions-sidebar
```

If the sidebar section is missing (rather than showing an error in place), the
plugin was likely skipped at resolution — see the troubleshooting notes below.

## Files

| File | Purpose |
| --- | --- |
| `tui.js` | Entry point required by the host (re-exports the panel) |
| `sessions-panel.js` | Implementation: rendering + SQLite data layer |
| `index.js` | Server-side stub (no server behavior needed) |

## Implementation notes / known traps

- The `cli.json` `plugins` entry **must start with `./`** (or `../`, an absolute
  path, or `file://`). A bare relative path like `tui-plugins/...` is parsed as a
  GitHub git shorthand (`github.com/tui-plugins/...`), and the host fails with
  `NpmInstallFailedError` at `stage=prepare` after ~5s.
- `package.json` must **not** have an `exports` field — the host self-references
  `<name>/tui` and silently skips the plugin if resolution fails. The entry must
  be the package-root `tui.js`.
- Don't add `@opentui/*` or `solid-js` as dependencies — the host rewrites them
  to its own instances; shipping your own splits the Solid instance.
- Theme colors in the real host are **packed `{buffer:[r,g,b,a]}` objects**, not
  hex strings — styled-text chunks must never carry a `null`/string `fg`.
- Windows: `process.env.HOME` is undefined, so the session DB path falls back
  `HOME → USERPROFILE → os.homedir()`.
- Text is clipped by **display column width** (CJK = 2 columns), not char count,
  to avoid splitting glyphs.

## License

MIT
