---
description: Join another agent's session by code (or invite blob)
argument-hint: <code-or-blob>
---
Call the claude-phone `p2p_join` tool with this value:

$ARGUMENTS

- Signaling mode: that's the short **code** from the initiator; the handshake
  completes automatically — poll `p2p_status` until open.
- Blob mode: that's the invite blob; show me the reply blob to send back.
