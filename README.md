# Sync

> The protocol layer for the way vibe-coders already work.

Run `claude` in 3 terminals on the same repo. **Sync** silently makes them aware of each other, prevents file-write collisions, and shares newly-created exports — automatically, with **zero workflow change**.

```
$ sync init        # one command, in your project
$ claude           # terminal 1
$ claude           # terminal 2
$ claude           # terminal 3
$ sync mon         # terminal 4 — watch the mesh
```

## Three pillars

1. **Awareness** — every Claude session sees what every other session is doing (intent, files in flight, completed exports).
2. **Conflict avoidance** — two sessions never write the same file at the same time. The second one is told politely to pivot.
3. **Result sharing** — when one session creates a new exported symbol, peers learn about it before their next turn — no spec, no `/commands`, no human in the loop.

No SaaS. No API key. No MCP server. No agent framework. Just Claude Code's built-in hooks + a tiny local Bun daemon (~127.0.0.1:7777).

## Install

Requires [Bun](https://bun.sh/) ≥ 1.3 and Claude Code ≥ 2.0.10.

```bash
git clone https://github.com/poosh1324/sync
cd sync
bun install
bun run src/cli/index.ts init   # in your project directory
bun run src/cli/index.ts mon    # in a separate terminal
```

`sync init` writes hooks into `.claude/settings.json`, copies the daemon and hook scripts to `~/.sync/`, and starts the daemon in the background.

## How it works

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ claude 1 │    │ claude 2 │    │ claude 3 │
└────┬─────┘    └────┬─────┘    └────┬─────┘
     │  hooks       │  hooks       │  hooks
     │ (4 lifecycle)│              │
     └──────────────┴──────────────┘
                    │
            ┌───────▼───────┐
            │ sync daemon   │  Bun.serve + bun:sqlite
            │ 127.0.0.1:7777│  state · locks · intents · exports
            └───────┬───────┘
                    │ /state every 500ms
            ┌───────▼───────┐
            │   sync mon    │  Ink TUI
            └───────────────┘
```

The four hooks Sync uses (registered automatically into your project's `.claude/settings.json`):

| Hook              | What Sync does                                                            |
| ----------------- | ------------------------------------------------------------------------- |
| `SessionStart`    | registers the session with the daemon, records cwd + git branch           |
| `UserPromptSubmit`| injects mesh context into Claude's system prompt; asks Claude to declare its intent in a `<sync-intent>` tag |
| `PreToolUse`      | for `Edit`/`Write`/`MultiEdit`: checks the file lock; denies politely if held |
| `PostToolUse`     | releases the lock; scans the saved file for new `export`s; broadcasts them; parses `<sync-intent>` from Claude's reply |

Intent extraction happens *inside the user's existing Claude session* — no extra LLM calls, no API key needed.

## CLI

```
sync init        # install hooks into the current project
sync mon         # open the mesh dashboard (Ink TUI)
sync status      # one-shot text dump of mesh state
sync stop        # kill the local daemon
sync uninstall   # cleanly remove Sync hook entries
```

## Why this and not...

- **claude-presence (MCP)**: requires `/register` and `/claim` slash commands run by hand. Sync is automatic and *enforced* via PreToolUse deny.
- **Claude Code Agent Teams**: top-down lead-coordinator model that needs a task list. Sync is peer-to-peer with no spec.
- **agent-orchestrator (worktree-per-agent)**: file-level isolation across separate worktrees. Sync runs all sessions on the **same working tree** with symbol-level awareness.

## Built at

CMUX × AIM Hackathon, Developer Tooling track — Sunday April 26, 2026, in 8 hours.

## License

MIT.
