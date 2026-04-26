---
description: "List peer Claude sessions on this repo with their plans and status."
allowed-tools: Bash(curl -s http://127.0.0.1:7777/*), Bash(pwd)
---

Show a clean table of peer sessions on THIS repo.

Current repo:

!`pwd`

Full mesh state:

!`curl -s http://127.0.0.1:7777/state/full`

Filter `sessions` to those whose `cwd` matches the pwd above. Group by status. Put `waiting` (queued) sessions first with ⏳, then `editing` ✏️, then `thinking` 🧠, then `idle`. For each peer show: label, short id, intent summary, will_modify files (basename only).
