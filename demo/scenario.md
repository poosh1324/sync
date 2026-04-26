# Sync — Live Web Demo (queue + auto-resume)

A 3-minute live demo of Sync coordinating three Claude Code sessions building a single web app in parallel — backend (A), frontend (B), styling (C). The browser is the visible payoff: when all three finish, the page shows a working comments board with API + UI + design, no merge conflicts.

## Setup (off-camera)

```bash
cd ~/Developer/sync-web-demo
syncc reset                    # wipe daemon state
syncc init                     # install hooks, daemon, slash commands
bun run dev                    # http://localhost:3000 (hot-reloads)
syncc mon                      # in pane 4
```

## Pane layout

```
┌──────────┬──────────┬──────────┐
│ claude A │ claude B │ claude C │
│ backend  │ frontend │  style   │
├──────────┴──────────┴──────────┤
│ syncc mon  │  http://:3000     │
└─────────────────────────────────┘
```

The browser tab on the bottom-right reloads as files change — the visible payoff.

## Talk track + actions

| t (s) | Action | What viewer sees |
|------:|--------|------------------|
| 0 | Open the empty scaffold in browser | Plain "Comments" heading, no list, no styling — bare bones |
| 8 | Paste prompt A in pane 1 | A's intent appears in mon: `Will modify: src/server.ts, src/api.ts` |
| 16 | Paste prompt B in pane 2 | B's intent appears: `Will modify: src/server.ts, public/app.js`. **mon shows ⏳ B QUEUED — waiting on A** because both need `src/server.ts` |
| 24 | Paste prompt C in pane 3 | C's intent: `Will modify: public/styles.css`. No overlap → C runs immediately |
| 35 | C finishes; browser hot-reloads | Page suddenly has a polished dark theme — but still no comments (A and B aren't done) |
| 60 | A finishes its API + server.ts edit | **mon: B ▶ RESUMED** — auto-dequeued. B's tool just returns and B starts editing |
| 80 | B finishes app.js + server.ts | Browser hot-reloads → composer form + comment list appear |
| 100 | Type a comment in the form, hit submit | Comment appears in the list — full stack working: B's UI → A's API → A's store |
| 120 | (optional) `git diff --stat` | 4 files changed, no conflicts |

## Prompts (paste exactly)

**A — Backend API**
```
Create src/api.ts that exports a `commentRoutes` array of { match, handle } entries for the routes registry. Implement:
- GET  /api/comments        → JSON list of all comments
- POST /api/comments        → body { content, userId } → create + return new comment
- DELETE /api/comments/:id  → delete by id, return { ok: true }

Use the table helper from ./db with a `Comment` type { id, content, userId, createdAt }. Then in src/server.ts, import commentRoutes and spread them into the `routes` array (push them, don't replace).
```

**B — Frontend UI**
```
Create public/app.js (vanilla JS, no bundler) that:
- Fetches GET /api/comments on load and renders each as <li>{content} — by {userId}</li> inside #comment-list.
- Renders a form inside #composer with a textarea (name=content), an input (name=userId placeholder="your name"), and a Submit button.
- On submit, POSTs JSON to /api/comments and re-renders.
- Re-fetches every 3 seconds so other sessions' changes show up live.

Then in src/server.ts, register a route in the `routes` array that serves /app.js as `application/javascript` from public/app.js.
```

**C — Styling**
```
Replace public/styles.css with a polished design: dark background, large readable typography, comment cards with subtle borders and hover highlight, sticky composer at the bottom, generous spacing, accent color for buttons. Use CSS variables for the palette. Make it look like a modern minimalist comments board.
```

## What to call out

1. **A and B both target `src/server.ts`** — that's the shared file. Sync's plan check sees this BEFORE either edit happens.
2. **B's first tool call hangs** — point at mon's yellow `B ⏳ QUEUED` event, point at B's pane (no error, just waiting).
3. **C ships independently** — the page restyles while A and B are still negotiating. "C didn't have to wait — Sync only blocks where there's actual overlap."
4. **A finishes, B auto-resumes** — green `▶ RESUMED` event. B writes its server.ts entry on top of A's. **No human re-trigger of B.**
5. **Browser shows the result** — composer form appears, you type a comment, it shows up in the list. Three sessions, one coherent working app.

## Slash command demo (bonus)

In any claude pane, mid-demo:
```
/sync-me
```
→ Claude prints a table showing this pane's session label + peers + status (including B's queued state). Visible proof that any session can introspect the mesh on demand.

## If something fails on stage

- **B doesn't queue** → A finished server.ts too fast. Restart with longer A: append `Add JSDoc to every export and add 5 // example: lines at the bottom.`
- **Browser doesn't update** → check Bun --hot picked up the change; refresh manually.
- **Daemon dead** → `syncc reset && syncc init`.
- **All claude panes look stuck** → `pkill -f '^claude$'`, restart panes.

## Tear-down

```bash
syncc uninstall    # in sync-web-demo
```
