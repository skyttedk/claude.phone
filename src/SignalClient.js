'use strict';
/**
 * Signaling client — drives a P2PChannel handshake over the relay (signal-server)
 * so two agents connect by a short CODE instead of pasting SDP blobs.
 *
 * It reuses the channel's existing self-contained offer/answer blobs (ICE baked
 * in); the relay just moves them between the two sockets. Once the WebRTC data
 * channel opens, messages flow directly P2P and the relay socket is closed.
 *
 * Enabled in the MCP server when CLAUDE_PHONE_SIGNAL_URL is set.
 */
const WebSocket = require('ws');

const HANDSHAKE_TIMEOUT_MS = Number(process.env.CLAUDE_PHONE_SIGNAL_TIMEOUT_MS || 30000);
const CODE_TIMEOUT_MS = 10000;

function connect(url) {
    return new Promise((resolve, reject) => {
        let ws;
        try {
            ws = new WebSocket(url);
        } catch (e) {
            return reject(e);
        }
        ws.once('open', () => resolve(ws));
        ws.once('error', (e) =>
            reject(new Error('signal connect failed (' + url + '): ' + e.message))
        );
    });
}

/**
 * Buffers incoming relay messages and lets callers await a message of a given
 * type, so strictly-ordered handshake steps never miss an early arrival.
 * Any {type:"error"} or {type:"peer-left"} rejects the pending waiter.
 */
class Mailbox {
    constructor(ws) {
        this.q = [];
        this.waiters = [];
        ws.on('message', (raw) => {
            let m;
            try {
                m = JSON.parse(raw.toString());
            } catch (_) {
                return;
            }
            this.q.push(m);
            this._pump();
        });
    }

    _pump() {
        for (let i = 0; i < this.waiters.length; ) {
            const w = this.waiters[i];
            const idx = this.q.findIndex(w.match);
            if (idx >= 0) {
                const [msg] = this.q.splice(idx, 1);
                this.waiters.splice(i, 1);
                clearTimeout(w.timer);
                w.settle(msg);
            } else {
                i++;
            }
        }
    }

    /** Await the next message whose type is in `types` (or a fatal error). */
    wait(types, label, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
        const want = new Set(types);
        const fatal = (m) => m.type === 'error' || m.type === 'peer-left';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = this.waiters.findIndex((x) => x.timer === timer);
                if (i >= 0) this.waiters.splice(i, 1);
                reject(new Error('signal: timed out waiting for ' + label));
            }, timeoutMs);
            this.waiters.push({
                timer,
                match: (m) => want.has(m.type) || fatal(m),
                settle: (m) => {
                    if (fatal(m) && !want.has(m.type)) {
                        reject(new Error('signal: ' + (m.error || m.type)));
                    } else {
                        resolve(m);
                    }
                },
            });
            this._pump();
        });
    }
}

function closeSoon(ws) {
    // Let the final handshake message flush, then free the relay room.
    setTimeout(() => {
        try {
            ws.close();
        } catch (_) {
            /* ignore */
        }
    }, 800);
}

/**
 * Initiator. Resolves with { code, ws, done }: share `code` immediately; `done`
 * resolves once the offer/answer round-trip finishes (channel then opens).
 */
async function host({ url, channel, onLog }) {
    const log = onLog || (() => {});
    const ws = await connect(url);
    const box = new Mailbox(ws);

    ws.send(JSON.stringify({ type: 'create' }));
    const created = await box.wait(['created'], 'room code', CODE_TIMEOUT_MS);
    const code = created.code;

    const done = (async () => {
        await box.wait(['peer-ready'], 'peer to join');
        log('signal: peer joined; creating offer');
        const offer = await channel.createOffer();
        ws.send(JSON.stringify({ type: 'signal', data: { blob: offer } }));
        const ans = await box.wait(['signal'], 'answer');
        channel.acceptAnswer(ans.data.blob);
        log('signal: answer received; data channel opening');
        closeSoon(ws);
    })();

    return { code, ws, done };
}

/**
 * Responder. Resolves with { ws, done }; `done` resolves once the answer is sent
 * (channel then opens).
 */
async function join({ url, code, channel, onLog }) {
    const log = onLog || (() => {});
    const ws = await connect(url);
    const box = new Mailbox(ws);

    ws.send(JSON.stringify({ type: 'join', code }));
    await box.wait(['joined'], 'join ack', CODE_TIMEOUT_MS);

    const done = (async () => {
        await box.wait(['peer-ready'], 'peer-ready');
        const off = await box.wait(['signal'], 'offer');
        log('signal: offer received; creating answer');
        const answer = await channel.acceptOffer(off.data.blob);
        ws.send(JSON.stringify({ type: 'signal', data: { blob: answer } }));
        log('signal: answer sent; data channel opening');
        closeSoon(ws);
    })();

    return { ws, done };
}

module.exports = { host, join };
