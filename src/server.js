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

// ---- Single-channel session state -----------------------------------------
// One server instance hosts one P2P channel (one conversation partner).
let channel = null;
const inbox = []; // received messages awaiting p2p_inbox drain
const events = []; // recent state-change log for diagnostics

function logEvent(msg) {
    events.push({ t: new Date().toISOString(), msg });
    if (events.length > 50) events.shift();
}

function newChannel() {
    return new P2PChannel({
        onMessage: (text) => {
            inbox.push({ t: new Date().toISOString(), text });
        },
        onStateChange: (state) => logEvent('state: ' + state),
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
            'RESPONDER. Takes the INITIATOR\'s invite blob and returns a base64 reply blob. ' +
            'Give the reply back to the initiator (who runs p2p_confirm). The data channel ' +
            'opens shortly after.',
        inputSchema: { invite: z.string().describe('The base64 invite blob from the initiator') },
    },
    async ({ invite }) => {
        try {
            if (channel) return errorText('A channel already exists. Call p2p_reset first to start over.');
            channel = newChannel();
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
        if (channel) { try { channel.dispose(); } catch (_) {} }
        channel = null;
        inbox.length = 0;
        events.length = 0;
        return text('Channel reset. Ready for a new connection.');
    }
);

// ---- Boot ------------------------------------------------------------------
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stderr is safe for logs; stdout is reserved for the MCP protocol.
    process.stderr.write('[claude.phone] MCP server ready on stdio\n');
}

function shutdown() {
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
