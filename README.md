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

## Connect by code (signaling) — recommended

Pasting 1.3 KB blobs by hand is the main friction. Run the bundled
[`signal-server/`](signal-server/) (a tiny WebSocket matchmaker) and set
`CLAUDE_PHONE_SIGNAL_URL`, and the handshake collapses to a short **code**:

```
Agent A:  p2p_invite            -> "INVITE code: vy5827"   (share the code)
Agent B:  p2p_join vy5827       -> connects automatically
Both:     p2p_status            -> "open": true            (no p2p_confirm needed)
```

The relay only brokers the SDP/ICE handshake; once connected, messages flow
**directly P2P** and never touch it — so one public instance is safe to share.
Set the URL in the plugin's MCP env (or your `.mcp.json`):

```json
"env": { "CLAUDE_PHONE_SIGNAL_URL": "wss://your-app.up.railway.app" }
```

Without `CLAUDE_PHONE_SIGNAL_URL`, the server stays in blob mode (above) — the
fully serverless fallback. See [`signal-server/README.md`](signal-server/README.md)
for the Railway deploy.

## Real-time receive (no manual polling)

MCP can't push into the agent loop, so a naive setup means calling `p2p_inbox`
by hand. Two mechanisms remove that — pick one or use both.

The server mirrors every inbound message to a small `pending.json` file (in
`$CLAUDE_PHONE_STATE_DIR`, default `<tmp>/claude-phone`). Separate processes
that can't call MCP tools watch that file.

### Architecture A — background watcher (live session, ~0 idle cost)

`scripts/wait-for-message.js` blocks in a plain Node process (no model tokens)
until a message lands, then exits. Claude Code re-invokes the agent when a
**backgrounded** command finishes — so that exit is the "onmessage" wake. The
agent drains `p2p_inbox`, replies, and relaunches the watcher.

Drive it with the `/listen` command. Event-driven, sub-second, near-zero idle
cost — but the watcher lives in the session, so it ends when the session closes.

A `Stop` hook (`scripts/check-inbox.js`, wired by the plugin) complements this:
it blocks the agent from going idle while messages are still unread.

### Architecture B — autonomous responder (always-on, no session)

Run the server with `CLAUDE_PHONE_AUTORESPOND=1` (or double-click
`autorespond.cmd`). On each inbound message it spawns a headless `claude -p`
run to compose a reply and sends it back automatically — a self-answering agent
endpoint that needs no interactive session.

| Env | Purpose |
|-----|---------|
| `CLAUDE_PHONE_AUTORESPOND` | Any value enables autonomous replies. |
| `CLAUDE_PHONE_CLAUDE_BIN` | Path to the `claude` CLI (default `claude`). |
| `CLAUDE_PHONE_PERSONA` | Optional framing for the agent's voice. |
| `CLAUDE_PHONE_STATE_DIR` | Where `pending.json` lives (server + watcher must agree). |

**The one thing neither solves:** waking a *fully closed* session from outside.
A wakes a live-but-idle session; B answers without a session at all. Between
them you get real-time agent-to-agent chat.

## Install as a plugin

The repo doubles as a single-plugin marketplace, bundling the MCP server, the
`/invite` `/join` `/confirm` `/send` `/inbox` `/listen` `/p2p-status` commands,
and the Stop hook.

Use the **full HTTPS URL** (the `owner/repo` shorthand defaults to SSH, which
fails on machines without GitHub SSH keys configured):

```
/plugin marketplace add https://github.com/skyttedk/claude.phone.git
/plugin install claude-phone@claude-phone
```

Restart Claude Code so the MCP server and Stop hook load. On its **first**
launch the bootstrap (`scripts/start-server.js`) installs the native
`node-datachannel` dependency automatically — plugins don't run `npm install`,
so the server does it itself. This first run can take a while; if the MCP
server times out, just restart once (deps will be in place by then).

Update later with `/plugin marketplace update claude-phone`.

> Fallback: if the auto-install fails (e.g. `npm` not on PATH), install deps
> by hand: `cd ~/.claude/plugins/marketplaces/skyttedk-claude-phone && npm install`.

## Notes & limits

- **Receiving messages:** MCP has no native push, but the watcher (Architecture A)
  and autonomous responder (Architecture B) above make receive event-driven. The
  raw `p2p_inbox` / `p2p_status` polling path still works as a fallback.
- **One peer per server instance.** A server hosts a single channel. Use
  `p2p_reset` to start a new conversation.
- **Symmetric / strict NAT:** STUN alone can fail behind some NATs; a real
  deployment there would need a TURN relay (not configured, to stay serverless).
- **Handshake is time-bounded:** ICE gathering must finish within 15 s, and the
  offer should be answered reasonably promptly.

## Layout

- `src/P2PChannel.js` — the reusable serverless WebRTC transport (no MCP).
- `src/server.js` — the MCP server wrapping it as tools.
- `src/SignalClient.js` — connect-by-code handshake over the relay (opt-in).
- `signal-server/` — the WebSocket matchmaker (deploy to Railway).
- `src/state.js` — mirrors inbound messages to `pending.json` (the receive bridge).
- `src/autoresponder.js` — Architecture B: headless-Claude autonomous replies.
- `scripts/wait-for-message.js` — Architecture A: background watcher (the wake).
- `scripts/check-inbox.js` — Stop hook: blocks idle while messages are unread.
- `.claude/commands/` — `/invite` `/join` `/confirm` `/send` `/inbox` `/listen` `/p2p-status`.
- `.claude-plugin/` — plugin + marketplace manifests.
- `test/loopback.js` — full 2-peer handshake + message exchange in one process.
- `test/mcp-smoke.js` — boots the MCP server and exercises the tool surface.
