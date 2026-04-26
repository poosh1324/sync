# Sync

> **The kernel layer for AI agent orchestration.**
> OS coordinated processes. Databases coordinated transactions. Compilers coordinated symbols.
> The next system layer to build is the one that coordinates **AI agents**. Sync is a first attempt.

Run `claude` in 3 terminals on the same repo. **Sync** silently makes them aware of each other, queues conflicting writes, and shares newly-created exports — automatically, with **zero workflow change** and **no extra LLM calls**.

```
$ syncc init        # one command, in your project
$ claude            # terminal 1 — labeled [A]
$ claude            # terminal 2 — labeled [B]
$ claude            # terminal 3 — labeled [C]
$ syncc mon         # terminal 4 — watch the mesh live
```

---

## Why Sync exists

Spin up two AI coding agents on the same repo and you get the same problems we've solved before in OS, DB, and compiler design — but at the agent layer:

- They overwrite each other's files.
- They redo each other's work because neither sees what the other built.
- They have no shared notion of *intent*, *locks*, or *symbols*.

Existing approaches reach for a **coordinator LLM** — a top-level orchestrator that plans, delegates, and reconciles. That works, but it costs an API key, adds latency, and makes the whole system depend on a SaaS.

**Sync's bet is different:** the agents you're already running are intelligent enough to coordinate themselves — *if* a tiny local layer feeds them the right context and enforces the right boundaries. So Sync injects mesh awareness into Claude's existing turns and intercepts at the tool boundary. The orchestration intelligence is a free side-effect of work the user is already paying for.

No coordinator LLM. No API key. No SaaS. No MCP server. Just Claude Code's built-in hooks + a small local Bun daemon (`127.0.0.1:7777`).

---

## The three pillars

1. **Awareness** — every Claude session sees what every other session is doing: intent, files in flight, completed exports, queue state.
2. **Conflict avoidance** — two sessions never write the same file at the same time. Sync queues the second one *transparently* (its tool call simply takes a moment longer) until the first finishes.
3. **Result sharing** — when one session creates a new exported symbol, peers learn about it before their next turn. No spec, no `/commands`, no human in the loop.

---

## Quick start

Requires [Bun](https://bun.sh/) ≥ 1.3 and Claude Code ≥ 2.0.10.

```bash
git clone https://github.com/poosh1324/sync
cd sync
bun install
bun link                         # registers `syncc` on your PATH

cd <your-project>
syncc init                       # in your project directory
syncc mon                        # in a separate terminal — live dashboard
```

> The CLI is named **`syncc`** (with two c's) so it never collides with the macOS/BSD `sync(8)` disk-flush command.

`syncc init` does five things, all reversible:

1. Writes Sync's hook entries into `.claude/settings.json`.
2. Copies the daemon and hook scripts to `~/.sync/` (so they're stable across project moves).
3. Installs three slash commands (`/sync-me`, `/sync-status`, `/sync-peers`) into `~/.claude/commands/`.
4. Adds Sync entries to `.gitignore` so your private hook config never gets committed.
5. Starts the local daemon in the background.

Now open one or more `claude` terminals in that project. Each one shows a banner like:

```
╭──────────────────────────────────────────────────────╮
│ You are session [B]   · peers: A                     │
│ Repo:   ~/code/myapp                                  │
│ Branch: main                                          │
│ Mesh:   2 sessions                                    │
│ View live: `syncc mon` in another pane                │
╰──────────────────────────────────────────────────────╯
```

That's it. They'll coordinate themselves from here.

---

## How it works

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ claude A │    │ claude B │    │ claude C │
└────┬─────┘    └────┬─────┘    └────┬─────┘
     │  6 hooks      │  6 hooks      │  6 hooks
     └───────────────┴───────────────┘
                     │
             ┌───────▼───────┐
             │ sync daemon   │  Bun.serve + bun:sqlite
             │ 127.0.0.1:7777│  sessions · locks · intents · exports
             └───────┬───────┘
                     │ /state every 500ms
             ┌───────▼───────┐
             │   syncc mon    │  Ink TUI dashboard
             └───────────────┘
```

Sync registers six hooks into your project's `.claude/settings.json`:

| Hook                | What it does                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `SessionStart`      | Registers the session, assigns a label (`A`, `B`, `C`, …), prints the welcome banner.               |
| `UserPromptSubmit`  | Injects mesh state + the `<sync-intent>` planning protocol into Claude's system prompt.             |
| `PreToolUse`        | Before each Edit/Write/MultiEdit, checks for conflicts. **If a peer holds it, queues — doesn't deny.** |
| `PostToolUse`       | Releases the file lock; scans for new `export`s; broadcasts them; updates the active intent.        |
| `Stop`              | Clears intent, prints a turn-summary box of who's still editing / queued in the repo.               |
| `SessionEnd`        | Cleans up on `/exit` or `/logout`. Survives `/clear`, compaction, and subagent ends.                |

### The `<sync-intent>` protocol

On every prompt, Sync asks Claude to emit a small block at the top of its response:

```xml
<sync-intent>
{
  "summary": "Refactor auth middleware",
  "will_modify": ["src/auth/middleware.ts", "src/auth/types.ts"],
  "will_create": ["validateToken"],
  "depends_on": []
}
</sync-intent>
```

The user never sees it — Sync strips it from view. But peers do. This is how a session declares "here's what I'm about to touch" *without anyone running an extra LLM*.

### Queue, don't deny

When session B's plan overlaps session A's, Sync used to deny B's tool call. Now it **queues** it: B's `Edit` simply takes longer to return, and when A finishes (releases its lock or moves on), B's tool call resumes and runs normally. No retry logic on Claude's side. No human intervention.

After ~9 minutes of waiting, Sync gives up and denies with a clear message — but in normal use, conflicts clear in seconds.

---

## CLI reference

```
syncc init           # install hooks, daemon, slash commands; auto-update .gitignore
syncc mon            # live mesh dashboard (Ink TUI)
syncc status         # one-shot text dump of mesh state
syncc lock <file>    # demo: hold a file lock so a peer session gets queued
syncc pause          # temporarily disable Sync (new sessions skip registration)
syncc resume         # re-enable
syncc stop           # kill the local daemon
syncc reset          # wipe daemon DB + restart fresh
syncc uninstall      # cleanly remove hooks, slash commands, .gitignore block
```

Inside any `claude` session, three slash commands are also available:

- `/sync-me` — who am I, what's my label, what are peers doing?
- `/sync-peers` — table of peer sessions on this repo grouped by status
- `/sync-status` — full mesh snapshot across all repos

---

## Privacy & isolation

- **Per-project** — Sync only activates in directories where you've run `syncc init`. Other repos are untouched.
- **Local-only** — Hook config lives in `.claude/settings.json` (auto-gitignored). Nothing leaves your machine.
- **Per-repo mesh** — Sessions are grouped by repo root. Two projects on the same machine never see each other's mesh.
- **Always visible** — Every `claude` session prints its label and repo. `syncc mon` shows the live mesh. `syncc status` for a snapshot.
- **Easy off-switch** — `syncc pause` (temporary), `syncc uninstall` (permanent — also cleans up `.gitignore`).

---

## Why this and not...

- **claude-presence (MCP)** — requires manual `/register` and `/claim` slash commands. Sync is automatic and *enforced* at the tool boundary.
- **Claude Code Agent Teams** — top-down lead-coordinator model that needs a task list. Sync is peer-to-peer with no spec.
- **agent-orchestrator (worktree-per-agent)** — file-level isolation across separate worktrees. Sync runs all sessions on the **same working tree** with symbol-level awareness.
- **Coordinator-LLM frameworks (LangGraph, CrewAI, etc.)** — add a planning LLM on top. Sync adds **zero** extra inference; coordination piggybacks on the agents you're already running.

---

## Built at

CMUX × AIM Hackathon, Developer Tooling track — Sunday April 26, 2026, in 8 hours.

## License

MIT.
