'use strict';
/**
 * End-to-end signaling test: boots the signal server, then connects two real
 * P2PChannels by CODE through it and exchanges a message. Proves the relay path
 * replaces the manual blob copy-paste. Run: node test/signaling.js
 */
const { spawn } = require('child_process');
const path = require('path');
const { P2PChannel } = require('../src/P2PChannel');
const signaling = require('../src/SignalClient');

const PORT = 8097;
// Use a live relay if CLAUDE_PHONE_SIGNAL_URL is set; otherwise boot a local one.
const LIVE_URL = process.env.CLAUDE_PHONE_SIGNAL_URL || null;
const URL = LIVE_URL || 'ws://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitOpen(ch, ms = 20000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('channel open timeout')), ms);
        const iv = setInterval(() => {
            if (ch.isOpen()) {
                clearInterval(iv);
                clearTimeout(t);
                resolve();
            }
        }, 100);
    });
}

async function main() {
    let srv = null;
    if (!LIVE_URL) {
        srv = spawn('node', [path.join(__dirname, '..', 'signal-server', 'server.js')], {
            env: { ...process.env, PORT: String(PORT) },
            stdio: 'ignore',
        });
        await sleep(600);
    } else {
        process.stdout.write('using live relay: ' + LIVE_URL + '\n');
    }

    let failed = false;
    const got = [];
    const A = new P2PChannel({ onMessage: () => {} });
    const B = new P2PChannel({ onMessage: (m) => got.push(m) });

    try {
        const hosted = await signaling.host({ url: URL, channel: A, onLog: () => {} });
        process.stdout.write('ok  initiator got code: ' + hosted.code + '\n');

        const joined = await signaling.join({ url: URL, code: hosted.code, channel: B, onLog: () => {} });

        await Promise.all([hosted.done, joined.done]);
        process.stdout.write('ok  handshake completed over relay\n');

        await Promise.all([waitOpen(A), waitOpen(B)]);
        process.stdout.write('ok  both data channels open\n');

        A.send('hello over signaling');
        await sleep(500);
        const received = got.includes('hello over signaling');
        process.stdout.write((received ? 'ok  ' : 'FAIL ') + 'message delivered P2P\n');
        if (!received) failed = true;
    } catch (e) {
        process.stdout.write('FAIL threw: ' + e.message + '\n');
        failed = true;
    } finally {
        try { A.dispose(); } catch (_) {}
        try { B.dispose(); } catch (_) {}
        if (srv) srv.kill();
    }

    process.stdout.write('\nRESULT: ' + (failed ? 'FAIL' : 'PASS ✓') + '\n');
    process.exit(failed ? 1 : 0);
}
main();
