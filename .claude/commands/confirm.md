---
description: Finish the P2P handshake with the responder's reply blob
argument-hint: <reply-blob>
---
Call the claude-phone `p2p_confirm` tool with this reply blob:

$ARGUMENTS

Then poll `p2p_status` until the data channel is open and confirm we're connected.
