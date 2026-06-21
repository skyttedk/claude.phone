# claude.phone

A **serverless peer-to-peer transport** that lets two AI-agent sessions (e.g. two
Claude Code instances) on **different machines across the internet** talk directly
to each other. Exposed as an **MCP server**.

- **No signaling server, no broker.** The WebRTC SDP offer/answer handshake is
  exchanged out-of-band — the two agents (or you) copy-paste one base64 blob per
  step. Google STUN is used only for NAT traversal; it never relays your data.
- **Direct P2P.** Once connected, messages flow over a WebRTC DataChannel straight
  between the two machines.
- Built on [`node-datachannel`](https://github.com/murat-dogan/node-datachannel)
  (libdatachannel). Inspired by the PeerJS+STUN engine in `fortea.game.engine`,
  but reimplemented broker-free for Node.

## Install

```sh
npm install
npm test        # runs the loopback + MCP smoke tests
```

## Register with Claude Code

Add to your MCP config (e.g. `.mcp.json` in a project, or `claude mcp add`):

```json
{
  "mcpServers": {
    "claude-phone": {
      "command": "node",
      "args": ["C:/nerdy/claude.phone/src/server.js"]
    }
  }
}
```

Both machines run their own copy of the server.

## Tools

| Tool | Who | Purpose |
|------|-----|---------|
| `p2p_invite` | Initiator | Returns an **invite** blob. Give it to the other agent. |
| `p2p_join` | Responder | Takes the invite, returns a **reply** blob. Give it back. |
| `p2p_confirm` | Initiator | Takes the reply; finishes the handshake. |
| `p2p_send` | Both | Send a text message to the peer. |
| `p2p_inbox` | Both | Drain messages received from the peer (poll this). |
| `p2p_status` | Both | Role, connection/ICE state, open?, stats, pending inbox. |
| `p2p_reset` | Both | Tear down and start over. |

## Handshake flow

```
  Agent A (initiator)                     Agent B (responder)
  ───────────────────                     ───────────────────
  p2p_invite        ─── invite blob ──►   p2p_join
  p2p_confirm       ◄── reply blob ────   (returns reply)
       │                                       │
       └─────── channel opens (poll p2p_status) ───────┘

  Then either side: p2p_send "hello"   /   p2p_inbox
```

The invite/reply blobs are ~1.3 KB base64 strings. Paste the whole thing.

> Under the hood these are the standard WebRTC *offer* / *answer* — `invite`/`reply`
> are just friendlier names for the same handshake.

## Notes & limits

- **Polling for messages:** MCP is request/response, so there's no push into the
  agent loop. Call `p2p_inbox` to read what arrived. `p2p_status` shows a pending
  count.
- **One peer per server instance.** A server hosts a single channel. Use
  `p2p_reset` to start a new conversation.
- **Symmetric / strict NAT:** STUN alone can fail behind some NATs; a real
  deployment there would need a TURN relay (not configured, to stay serverless).
- **Handshake is time-bounded:** ICE gathering must finish within 15 s, and the
  offer should be answered reasonably promptly.

## Layout

- `src/P2PChannel.js` — the reusable serverless WebRTC transport (no MCP).
- `src/server.js` — the MCP server wrapping it as tools.
- `test/loopback.js` — full 2-peer handshake + message exchange in one process.
- `test/mcp-smoke.js` — boots the MCP server and exercises the tool surface.
