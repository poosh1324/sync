---
description: "Show this Claude session's Sync identity (label, repo, status, peers)."
allowed-tools: Bash(curl -s http://127.0.0.1:7777/*), Bash(pwd)
---

The Sync daemon at http://127.0.0.1:7777 holds the live mesh state. Read it and tell the user:

- Which session label am I in this terminal (A, B, C, ...)?
- Repo + branch
- Current status (idle / thinking / editing / waiting)
- Each peer in this repo: label, status, intent summary

Current working directory:

!`pwd`

Full mesh state (all repos):

!`curl -s http://127.0.0.1:7777/state/full`

Daemon health:

!`curl -s http://127.0.0.1:7777/health`

Filter the sessions array to ones where `cwd` matches the pwd above. Identify ME (this session) by matching the most-recent session for this cwd. Render a compact table:

```
[me]    [A]  ✏️ editing   "summary…"
[peer]  [B]  ⏳ queued    "summary…"
[peer]  [C]  · idle       "summary…"
```

Put queued sessions on top with a ⏳ marker.
