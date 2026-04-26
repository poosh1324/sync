# Sync — Demo Scenario

A 3-minute live demo of Sync coordinating three concurrent Claude Code sessions on the same repo, with the `sync mon` TUI on a fourth pane showing the mesh light up in real time.

## Setup (off-camera, before the pitch)

In a fresh terminal:

```bash
cd <demo-repo>            # any small TS/JS app
git checkout -b sync-demo # so we can git diff at the end
sync init                 # writes hooks into .claude/settings.json
```

Open a 2×2 tmux split (or 4 iTerm panes):

```
┌──────────┬──────────┐
│ claude 1 │ claude 2 │
├──────────┼──────────┤
│ claude 3 │ sync mon │
└──────────┴──────────┘
```

Have `sync mon` running in the bottom-right pane already.

## Live demo flow

| t (s) | Pane | Action |
|------:|------|--------|
| 0     | —    | "How many of you run two or three Claude sessions at once on the same repo? They overwrite each other. Today I built the missing layer." |
| 10    | C1   | `claude` → "Implement a `Comment` model with `createComment(content, userId)` and `getComments()`." |
| 18    | mon  | a3f appears in mesh; intent extracted; lock acquired on `src/models/comment.ts` |
| 22    | C2   | `claude` → "Implement a `Like` feature. Likes attach to comments." |
| 28    | mon  | b8e appears; sync injected `Comment` from a3f's exports; b8e announces dependency |
| 35    | C3   | `claude` → "Add a function to update a comment's content. Use `createComment` if needed." |
| 42    | mon  | c2d appears; tries to write `comment.ts` → DENIED → red flash; pivots to `commentEdit.ts` |
| 60    | mon  | a3f finishes, exports propagate to b8e/c2d on next prompt |
| 90    | C2/3 | b8e and c2d use `Comment` and `createComment` instead of redeclaring; finish in parallel |
| 130   | C1   | `git diff` — three clean changes, one shared `Comment` type, no merge conflicts |
| 150   | —    | "I gave it no spec. No coordinator. No `/commands`. Just three terminals — like I always do." |

## What to call out

1. **Awareness** — when b8e starts, the `<sync-context>` block (pre-injected) shows "session a3f is editing comment.ts; planned exports: Comment, createComment". Claude reads it on its own.
2. **Conflict avoidance** — c2d's red `BLOCKED` event in the TUI is the most visceral moment. The `permissionDecisionReason` is human language ("File X is currently being edited by session ABC. Try a different file.") and Claude pivots without intervention.
3. **Result sharing** — the moment a3f finishes its first edit and `export class Comment` is detected, the next b8e prompt's injected context shows `Comment` as a peer-created symbol, and Claude uses it.

## If something fails on stage

- **Daemon not running**: hooks fail silently. Run `sync stop && sync init` to restart.
- **Stale lock holding things up**: locks expire after 60s. Or `curl -X POST http://127.0.0.1:7777/locks/release -d '...'`.
- **Demo session ID file missing**: re-run `sync init`. It also auto-starts the daemon.
