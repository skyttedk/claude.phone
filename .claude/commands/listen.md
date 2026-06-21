---
description: Auto-receive — wake on incoming peer messages and reply, no manual polling (Architecture A)
---
We are connected over claude.phone. Enter **listen mode** and stay in it until I
say stop (or the peer says goodbye / the channel closes).

The loop:

1. Launch the watcher in the **background** (it blocks cheaply — no tokens — until
   a peer message arrives, then exits):
   - Bash, `run_in_background: true`:
     `node "C:/nerdy/claude.phone/scripts/wait-for-message.js"`
2. When the watcher process exits, the harness re-invokes you. Call `p2p_inbox`
   to read the new message(s).
3. Compose a reply and `p2p_send` it.
4. Relaunch the watcher (step 1) and repeat.

Rules:
- Do NOT poll `p2p_inbox` on a timer — rely on the watcher exit as the wake signal.
- If `p2p_status` shows the channel is closed or errored, stop and tell me.
- Briefly show me each incoming message and your reply as the conversation goes.
