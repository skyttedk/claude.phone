# claude.phone signal server

A tiny WebSocket **matchmaker** so two agents can complete a WebRTC handshake by
a short room **code** instead of pasting SDP blobs by hand.

It relays **only** the handshake (SDP offer/answer + trickled ICE candidates)
between the two sockets in a room. Once peers connect, their messages flow
**directly P2P** over the DataChannel and never touch this server — so it is safe
to host publicly and share one instance across users.

## Run locally

```sh
cd signal-server
npm install
npm start              # listens on :8080 (or $PORT)
```

`GET /` returns a plain-text health line (used by Railway's healthcheck).

## Deploy to Railway

The CLI deploys the current directory, so deploy from **inside** `signal-server/`:

```sh
railway login                       # log in to the FORTEA account in the browser
cd signal-server
railway init                        # create/select a project in the Fortea account
railway up                          # build + deploy
railway domain                      # generate a public URL
```

Railway sets `PORT`; the server reads it. Copy the generated `*.up.railway.app`
host — the client uses it as `wss://<host>` via `CLAUDE_PHONE_SIGNAL_URL`.

## Protocol (JSON over WebSocket)

| From client | Server replies |
|---|---|
| `{type:"create"}` | `{type:"created", code}` |
| `{type:"join", code}` | `{type:"joined"}` then both get `{type:"peer-ready", role}` |
| `{type:"signal", data}` | relayed to the other peer as `{type:"signal", data}` |
| `{type:"bye"}` / disconnect | other peer gets `{type:"peer-left"}` |

Env: `PORT`, `ROOM_TTL_MS` (unpaired-room lifetime, default 10 min),
`MAX_ROOMS` (default 5000).
