'use strict';
/**
 * Signal-server smoke test: boots the server, connects two clients, and verifies
 * code-based pairing + bidirectional signal relay. Run: node test/smoke.js
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8099;
const URL = 'ws://127.0.0.1:' + PORT;

function open() {
    return new Promise((res, rej) => {
        const ws = new WebSocket(URL);
        ws.on('open', () => res(ws));
        ws.on('error', rej);
    });
}
function next(ws) {
    return new Promise((res) => ws.once('message', (m) => res(JSON.parse(m.toString()))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: 'ignore',
    });
    await sleep(600);

    let failed = false;
    const check = (cond, label) => {
        process.stdout.write((cond ? 'ok  ' : 'FAIL ') + label + '\n');
        if (!cond) failed = true;
    };

    try {
        const a = await open();
        a.send(JSON.stringify({ type: 'create' }));
        const created = await next(a);
        check(created.type === 'created' && !!created.code, 'initiator gets a room code');

        const b = await open();
        const aReadyP = next(a);
        b.send(JSON.stringify({ type: 'join', code: created.code }));
        const joined = await next(b); // {joined} then {peer-ready}; first is joined
        check(joined.type === 'joined', 'responder joins existing room');
        const aReady = await aReadyP;
        check(aReady.type === 'peer-ready' && aReady.role === 'initiator', 'initiator told peer-ready');

        // signal A -> B
        const bSig = next(b);
        a.send(JSON.stringify({ type: 'signal', data: { sdp: 'offer-xyz' } }));
        const got = await bSig;
        check(got.type === 'signal' && got.data.sdp === 'offer-xyz', 'A->B signal relayed');

        // signal B -> A
        const aSig = next(a);
        b.send(JSON.stringify({ type: 'signal', data: { ice: 'cand-1' } }));
        const got2 = await aSig;
        check(got2.type === 'signal' && got2.data.ice === 'cand-1', 'B->A signal relayed');

        // join a bad code
        const c = await open();
        c.send(JSON.stringify({ type: 'join', code: 'zzzzzz' }));
        const err = await next(c);
        check(err.type === 'error' && err.error === 'no-such-room', 'join unknown room errors');

        // disconnect A -> B notified
        const bLeft = next(b);
        a.close();
        const left = await bLeft;
        check(left.type === 'peer-left', 'peer-left on disconnect');

        a.close(); b.close(); c.close();
    } catch (e) {
        check(false, 'threw: ' + e.message);
    }

    srv.kill();
    process.stdout.write('\nRESULT: ' + (failed ? 'FAIL' : 'PASS ✓') + '\n');
    process.exit(failed ? 1 : 0);
}
main();
