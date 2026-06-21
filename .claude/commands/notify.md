---
description: Desktop ping on incoming peer messages — zero tokens, no model turns
---
Start the **zero-token desktop notifier** so I get an OS notification the moment a
peer message arrives, without waking the agent loop.

Launch the daemon in the **background** (it polls pending.json and fires OS
notifications itself — it never re-invokes you, so it costs no tokens):

- Bash, `run_in_background: true`:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/notify-loop.js"`

Then tell me it's running and that I can stop it later by killing that background
task. Do NOT poll or re-launch it; once started it runs on its own until stopped
or the session ends.

Note: this only *notifies* — it does not read or reply. To read/reply, use
`/claude-phone:inbox` + `/claude-phone:send`, or `/claude-phone:listen` for an
agent-driven auto-reply loop.
