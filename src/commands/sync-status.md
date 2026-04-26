---
description: "Dump the full Sync mesh state across all repos (sessions, locks, recent exports)."
allowed-tools: Bash(curl -s http://127.0.0.1:7777/*)
---

Pull the global Sync state from the local daemon and summarize it. Highlight queued sessions.

!`curl -s http://127.0.0.1:7777/state/full`

Format:
- Sessions: label · short id · repo · status · intent summary
- Active locks (file → holder)
- Recent exports

Call out any session with `status: "waiting"` at the top.
