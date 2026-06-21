/**
 * MCP smoke test: spawn the server over stdio, list tools, and exercise the
 * create_offer path. Validates MCP wiring + zod schemas (not the full 2-peer
 * handshake — see loopback.js for the transport itself).
 *
 * Run: node test/mcp-smoke.js
 */
'use strict';

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function main() {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(__dirname, '..', 'src', 'server.js')],
    });
    const client = new Client({ name: 'smoke', version: '1.0.0' });
    await client.connect(transport);

    const tools = await client.listTools();
    console.log('tools:', tools.tools.map((t) => t.name).join(', '));

    const status = await client.callTool({ name: 'p2p_status', arguments: {} });
    console.log('status ->', status.content[0].text.split('\n')[0]);

    console.log('creating invite (gathering ICE via STUN, ~seconds)...');
    const offer = await client.callTool({ name: 'p2p_invite', arguments: {} });
    const body = offer.content[0].text;
    const blob = body.split('\n\n')[1] || '';
    console.log('invite tool isError:', !!offer.isError);
    console.log('invite blob length:', blob.length);

    const status2 = await client.callTool({ name: 'p2p_status', arguments: {} });
    console.log('status2 role:', JSON.parse(status2.content[0].text).role);

    const pass = !offer.isError && blob.length > 500 && tools.tools.length === 7;
    console.log('\nRESULT:', pass ? 'PASS ✓' : 'FAIL ✗');

    await client.close();
    process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error('ERROR:', err); process.exit(1); });
