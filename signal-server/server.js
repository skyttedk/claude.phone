#!/usr/bin/env node
'use strict';
/**
 * claude.phone signaling relay.
 *
 * A lightweight matchmaker that lets two agents complete a WebRTC handshake by
 * a short room CODE instead of pasting SDP blobs by hand. It relays ONLY the
 * handshake (SDP offer/answer + trickled ICE candidates) between the two
 * sockets in a room. Once the peers connect, their actual messages flow
 * directly P2P over the DataChannel and never touch this server.
 *
 * Safe to run publicly: it sees handshake metadata only, never conversation data.
 *
 * Protocol (JSON over WebSocket):
 *   client -> {type:"create"}              server -> {type:"created", code}
 *   client -> {type:"join", code}          server -> {type:"joined"} / {type:"error"}
 *                                          both   -> {type:"peer-ready", role}
 *   client -> {type:"signal", data}        other  -> {type:"signal", data}
 *   either -> {type:"bye"} / disconnect    other  -> {type:"peer-left"}
 *
 * Env: PORT (Railway sets this), ROOM_TTL_MS, MAX_ROOMS.
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 10 * 60 * 1000); // unpaired room lifetime
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 5000);
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes
const CODE_LEN = 6;

/** code -> { initiator, responder, createdAt } */
const rooms = new Map();

function makeCode() {
    let code;
    do {
        const bytes = crypto.randomBytes(CODE_LEN);
        code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    } while (rooms.has(code));
    return code;
}

function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) {
        try {
            ws.send(JSON.stringify(obj));
        } catch (_) {
            /* ignore */
        }
    }
}

function peerOf(ws, room) {
    return ws === room.initiator ? room.responder : room.initiator;
}

function closeRoom(code, exceptWs) {
    const room = rooms.get(code);
    if (!room) return;
    for (const ws of [room.initiator, room.responder]) {
        if (ws && ws !== exceptWs) send(ws, { type: 'peer-left' });
    }
    rooms.delete(code);
}

const httpServer = http.createServer((req, res) => {
    // Health check / friendly root for Railway.
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('claude.phone signal server: ok (' + rooms.size + ' active rooms)\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.roomCode = null;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (_) {
            return send(ws, { type: 'error', error: 'bad-json' });
        }

        switch (msg.type) {
            case 'create': {
                if (rooms.size >= MAX_ROOMS) {
                    return send(ws, { type: 'error', error: 'server-full' });
                }
                const code = makeCode();
                rooms.set(code, { initiator: ws, responder: null, createdAt: Date.now() });
                ws.roomCode = code;
                send(ws, { type: 'created', code });
                break;
            }
            case 'join': {
                const room = rooms.get(String(msg.code || '').toLowerCase());
                if (!room) return send(ws, { type: 'error', error: 'no-such-room' });
                if (room.responder) return send(ws, { type: 'error', error: 'room-full' });
                room.responder = ws;
                ws.roomCode = ws.roomCode || [...rooms].find(([, r]) => r === room)[0];
                send(ws, { type: 'joined' });
                // Tell both sides their roles so they can start the handshake.
                send(room.initiator, { type: 'peer-ready', role: 'initiator' });
                send(room.responder, { type: 'peer-ready', role: 'responder' });
                break;
            }
            case 'signal': {
                const room = rooms.get(ws.roomCode);
                if (!room) return send(ws, { type: 'error', error: 'not-in-room' });
                send(peerOf(ws, room), { type: 'signal', data: msg.data });
                break;
            }
            case 'bye': {
                if (ws.roomCode) closeRoom(ws.roomCode, ws);
                break;
            }
            default:
                send(ws, { type: 'error', error: 'unknown-type' });
        }
    });

    ws.on('close', () => {
        if (ws.roomCode) closeRoom(ws.roomCode, ws);
    });
    ws.on('error', () => {
        if (ws.roomCode) closeRoom(ws.roomCode, ws);
    });
});

// Drop dead sockets.
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (_) {
            /* ignore */
        }
    }
}, 30000);

// Sweep stale unpaired rooms.
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (!room.responder && now - room.createdAt > ROOM_TTL_MS) {
            send(room.initiator, { type: 'error', error: 'room-expired' });
            rooms.delete(code);
        }
    }
}, 60000);

httpServer.listen(PORT, () => {
    process.stdout.write('[claude.phone signal] listening on :' + PORT + '\n');
});

function shutdown() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
