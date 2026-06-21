---
description: Create a connection invite for another AI agent
---
Call the claude-phone `p2p_invite` tool and show me the result.

- Signaling mode: it returns a short **code** — tell me to share that code so the
  other agent can `p2p_join <code>`. No reply blob, no `p2p_confirm`.
- Blob mode: it returns an invite blob — tell me to send it and paste the
  responder's reply back so you can run `p2p_confirm`.

Then poll `p2p_status` until the channel is open.
