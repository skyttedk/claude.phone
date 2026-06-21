#!/usr/bin/env node
/**
 * claude.phone MCP server
 *
 * Exposes a serverless peer-to-peer WebRTC transport as MCP tools so two
 * AI-agent sessions (e.g. two Claude Code instances) on different machines can
 * talk directly. No signaling server: the SDP handshake blobs are copy-pasted
 * between the two sessions. NAT traversal via Google STUN only.
 *
 * Handshake (one side is the INITIATOR, the other the RESPONDER):
 *   Initiator:  p2p_invite              -> invite blob  (give to peer)
 *   Responder:  p2p_join    <invite>    -> reply blob   (give back)
 *   Initiator:  p2p_confirm <reply>     -> connected
 *   Both then:  p2p_send <text> / p2p_inbox
 *
 * Run: node src/server.js   (stdio transport)
 */
'use strict';

const { z } = require('zod');
const ndc = require('node-datachannel');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { P2PChannel } = require('./P2PChannel');
const state = require('./state');
const { maybeCreate } = require('./autoresponder');

// Optional signaling relay: connect by short code instead of pasting blobs.
const SIGNAL_URL = process.env.CLAUDE_PHONE_SIGNAL_URL || null;
const signaling = SIGNAL_URL ? require('./SignalClient') : null;

// ---- Single-channel session state -----------------------------------------
// One server instance hosts one P2P channel (one conversation partner).
let channel = null;
let signalWs = null; // active relay socket during a signaling handshake
const inbox = []; // received messages awaiting p2p_inbox drain
const events = []; // recent state-change log for diagnostics

function logEvent(msg) {
    events.push({ t: new Date().toISOString(), msg });
    if (events.length > 50) events.shift();
}

// Architecture B: autonomous responder (null unless CLAUDE_PHONE_AUTORESPOND set).
const autoResponder = maybeCreate({
    send: (m) => {
        if (channel) channel.send(m);
    },
    log: logEvent,
});

function newChannel() {
    return new P2PChannel({
        onMessage: (text) => {
            inbox.push({ t: new Date().toISOString(), text });
            // Architecture A bridge: mirror unread messages to disk so the
            // background watcher / Stop hook (separate processes) can see them.
            state.writePending(inbox);
            if (autoResponder) {
                // Architecture B: the headless agent owns this reply. Hand it off
                // and drop it from the interactive inbox to avoid double-handling.
                autoResponder.handle(text);
                inbox.length = 0;
                state.clearPending();
            }
        },
        onStateChange: (s) => logEvent('state: ' + s),
    });
}

function text(content) {
    return { content: [{ type: 'text', text: content }] };
}

function errorText(content) {
    return { content: [{ type: 'text', text: content }], isError: true };
}

// ---- MCP server ------------------------------------------------------------
const server = new McpServer(
    { name: 'claude.phone', version: '1.0.0' },
    {
        instructions:
            'Serverless P2P transport between two AI-agent sessions. One agent is the ' +
            'INITIATOR: call p2p_invite, send the invite blob to the other agent. The other ' +
            'is the RESPONDER: call p2p_join with that invite, send the reply blob back. ' +
            'The INITIATOR calls p2p_confirm with the reply. Then both use p2p_send and ' +
            'poll p2p_inbox. Handshake blobs are large base64 strings exchanged out-of-band.',
    }
);

server.registerTool(
    'p2p_invite',
    {
        title: 'Create connection invite (initiator)',
        description:
            'INITIATOR step 1. Creates a serverless WebRTC invite and returns a base64 blob. ' +
            'Give this invite to the other agent so it can run p2p_join. May take a few ' +
            'seconds while ICE candidates are gathered via Google STUN.',
        inputSchema: {},
    },
    async () => {
        try {
            if (channel) return errorText('A channel already exists. Call p2p_reset first to start over.');
            channel = newChannel();

            if (signaling) {
                // Signaling mode: return a short code; the handshake auto-completes.
                const { code, ws, done } = await signaling.host({
                    url: SIGNAL_URL,
                    channel,
                    onLog: logEvent,
                });
                signalWs = ws;
                done.catch((e) => logEvent('signal handshake failed: ' + e.message));
                return text(
                    'INVITE code: ' + code + '\n\nGive this code to the other agent — they ' +
                    'run p2p_join with it. No reply blob and no p2p_confirm needed: poll ' +
                    'p2p_status until "open": true.'
                );
            }

            const invite = await channel.createOffer();
            return text(
                'INVITE created. Send this blob to the other agent, then wait for their reply ' +
                'and call p2p_confirm with it:\n\n' + invite
            );
        } catch (err) {
            channel = null;
            return errorText('Failed to create invite: ' + err.message);
        }
    }
);

server.registerTool(
    'p2p_join',
    {
        title: 'Join via invite (responder)',
        description:
            'RESPONDER. In signaling mode pass the short CODE from the initiator; the ' +
            'handshake completes automatically (poll p2p_status). In blob mode pass the ' +
            'initiator\'s base64 invite blob and this returns a reply blob to give back.',
        inputSchema: {
            invite: z
                .string()
                .describe('Signaling mode: the short connect code. Blob mode: the base64 invite blob.'),
        },
    },
    async ({ invite }) => {
        try {
            if (channel) return errorText('A channel already exists. Call p2p_reset first to start over.');
            channel = newChannel();

            if (signaling) {
                const code = invite.trim().toLowerCase();
                const { ws, done } = await signaling.join({
                    url: SIGNAL_URL,
                    code,
                    channel,
                    onLog: logEvent,
                });
                signalWs = ws;
                done.catch((e) => logEvent('signal handshake failed: ' + e.message));
                return text(
                    'Joining via code "' + code + '"... no reply blob needed. Poll p2p_status ' +
                    'until "open": true, then use p2p_send / p2p_inbox.'
                );
            }

            const reply = await channel.acceptOffer(invite);
            return text(
                'INVITE accepted. Send this REPLY blob back to the initiator:\n\n' + reply +
                '\n\nThen poll p2p_status until connected, and use p2p_send / p2p_inbox.'
            );
        } catch (err) {
            channel = null;
            return errorText('Failed to join: ' + err.message);
        }
    }
);

server.registerTool(
    'p2p_confirm',
    {
        title: 'Confirm reply (initiator)',
        description:
            'INITIATOR step 2. Takes the RESPONDER\'s reply blob to finish the handshake. ' +
            'After this the data channel opens within a few seconds (poll p2p_status).',
        inputSchema: { reply: z.string().describe('The base64 reply blob from the responder') },
    },
    async ({ reply }) => {
        try {
            if (signaling) {
                return text(
                    'Not needed in signaling mode — the handshake completes automatically. ' +
                    'Poll p2p_status until "open": true.'
                );
            }
            if (!channel) return errorText('No channel in progress. Call p2p_invite first.');
            if (channel.role !== 'initiator') return errorText('Only the initiator calls p2p_confirm.');
            channel.acceptAnswer(reply);
            return text('Reply confirmed. Poll p2p_status until "open": true, then use p2p_send / p2p_inbox.');
        } catch (err) {
            return errorText('Failed to confirm reply: ' + err.message);
        }
    }
);

server.registerTool(
    'p2p_send',
    {
        title: 'Send a message to the peer',
        description: 'Send a text message to the connected peer over the P2P data channel.',
        inputSchema: { message: z.string().describe('Text to send to the peer') },
    },
    async ({ message }) => {
        try {
            if (!channel) return errorText('No channel. Establish a connection first.');
            channel.send(message);
            return text('Sent (' + Buffer.byteLength(message, 'utf8') + ' bytes).');
        } catch (err) {
            return errorText('Send failed: ' + err.message);
        }
    }
);

server.registerTool(
    'p2p_inbox',
    {
        title: 'Drain received messages',
        description:
            'Returns and clears all messages received from the peer since the last call. ' +
            'Poll this to read incoming messages (MCP has no server push to the agent loop).',
        inputSchema: {},
    },
    async () => {
        if (inbox.length === 0) return text('(no new messages)');
        const drained = inbox.splice(0, inbox.length);
        state.clearPending(); // keep the on-disk mirror in sync for the watcher
        const rendered = drained.map((m) => '[' + m.t + '] ' + m.text).join('\n');
        return text(drained.length + ' message(s):\n' + rendered);
    }
);

server.registerTool(
    'p2p_status',
    {
        title: 'Connection status',
        description: 'Reports role, connection/ICE state, whether the channel is open, stats, and pending inbox count.',
        inputSchema: {},
    },
    async () => {
        if (!channel) return text('No channel. Use p2p_invite (initiator) or p2p_join (responder).');
        const st = channel.getState();
        return text(JSON.stringify({ ...st, pendingInbox: inbox.length, recentEvents: events.slice(-8) }, null, 2));
    }
);

server.registerTool(
    'p2p_reset',
    {
        title: 'Reset the channel',
        description: 'Tears down the current connection and clears the inbox so a new handshake can begin.',
        inputSchema: {},
    },
    async () => {
        if (signalWs) { try { signalWs.close(); } catch (_) {} signalWs = null; }
        if (channel) { try { channel.dispose(); } catch (_) {} }
        channel = null;
        inbox.length = 0;
        events.length = 0;
        state.clearPending();
        return text('Channel reset. Ready for a new connection.');
    }
);

// ---- Boot ------------------------------------------------------------------
async function main() {
    state.clearPending(); // drop any stale mirror from a previous run
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stderr is safe for logs; stdout is reserved for the MCP protocol.
    process.stderr.write(
        '[claude.phone] MCP server ready on stdio' +
            (signaling ? ' (signaling: ' + SIGNAL_URL + ')' : ' (blob mode)') +
            (autoResponder ? ' (autorespond ON)' : '') +
            '\n'
    );
}

function shutdown() {
    if (signalWs) { try { signalWs.close(); } catch (_) {} }
    if (channel) { try { channel.dispose(); } catch (_) {} }
    try { ndc.cleanup(); } catch (_) {}
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
    process.stderr.write('[claude.phone] fatal: ' + err.stack + '\n');
    process.exit(1);
});
