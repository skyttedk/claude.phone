/**
 * Loopback test: drive a full serverless handshake between two P2PChannel
 * instances in one process, then exchange a message each way.
 *
 * This validates the node-datachannel API usage without needing two machines.
 * Run: node test/loopback.js
 */
'use strict';

const ndc = require('node-datachannel');
const { P2PChannel } = require('../src/P2PChannel');

async function main() {
    let aGotMsg = null;
    let bGotMsg = null;

    const a = new P2PChannel({
        peerName: 'alice',
        onMessage: (m) => { aGotMsg = m; console.log('[A received]', m); },
        onStateChange: (s) => console.log('[A state]', s),
    });
    const b = new P2PChannel({
        peerName: 'bob',
        onMessage: (m) => { bGotMsg = m; console.log('[B received]', m); },
        onStateChange: (s) => console.log('[B state]', s),
    });

    console.log('1. A creates offer...');
    const offer = await a.createOffer();
    console.log('   offer blob length:', offer.length);

    console.log('2. B accepts offer, creates answer...');
    const answer = await b.acceptOffer(offer);
    console.log('   answer blob length:', answer.length);

    console.log('3. A accepts answer...');
    a.acceptAnswer(answer);

    console.log('4. Waiting for data channel to open...');
    await waitFor(() => a.isOpen() && b.isOpen(), 15000, 'channel open');

    console.log('5. Exchanging messages...');
    a.send('hello from alice');
    b.send('hi back from bob');

    await waitFor(() => aGotMsg && bGotMsg, 5000, 'messages delivered');

    const pass = aGotMsg === 'hi back from bob' && bGotMsg === 'hello from alice';
    console.log('\nRESULT:', pass ? 'PASS ✓' : 'FAIL ✗');
    console.log('A stats:', JSON.stringify(a.getState().stats));
    console.log('B stats:', JSON.stringify(b.getState().stats));

    a.dispose();
    b.dispose();
    ndc.cleanup();
    process.exit(pass ? 0 : 1);
}

function waitFor(cond, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const iv = setInterval(() => {
            if (cond()) { clearInterval(iv); resolve(); }
            else if (Date.now() - start > timeoutMs) {
                clearInterval(iv);
                reject(new Error('Timeout waiting for: ' + label));
            }
        }, 100);
    });
}

main().catch((err) => {
    console.error('ERROR:', err);
    try { ndc.cleanup(); } catch (_) {}
    process.exit(1);
});
