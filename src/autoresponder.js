'use strict';
/**
 * Architecture B — autonomous responder.
 *
 * Turns the always-on MCP server process into a self-answering agent endpoint:
 * when a peer message arrives, spawn a headless Claude Code run to compose a
 * reply and send it back over the channel — no interactive session required.
 *
 * Enabled when CLAUDE_PHONE_AUTORESPOND is set. Replies are serialized so they
 * stay ordered, and a short rolling transcript gives the headless agent context.
 *
 * Env:
 *   CLAUDE_PHONE_AUTORESPOND   any truthy value enables it
 *   CLAUDE_PHONE_CLAUDE_BIN    path to the claude CLI (default: "claude")
 *   CLAUDE_PHONE_PERSONA       optional extra system framing for the agent
 */
const { spawn } = require('child_process');

const MAX_TURNS = 12; // rolling transcript window kept for context

class AutoResponder {
    constructor({ send, log }) {
        this.send = send;
        this.log = log || (() => {});
        this.history = [];
        this.queue = Promise.resolve();
        this.bin = process.env.CLAUDE_PHONE_CLAUDE_BIN || 'claude';
        this.persona = process.env.CLAUDE_PHONE_PERSONA || '';
    }

    /** Queue a reply to an incoming peer message. Returns a promise. */
    handle(incoming) {
        this.queue = this.queue
            .then(() => this._reply(incoming))
            .catch((e) => this.log('autoresponder error: ' + e.message));
        return this.queue;
    }

    _buildPrompt(incoming) {
        this.history.push({ role: 'peer', text: incoming });
        const transcript = this.history
            .slice(-MAX_TURNS)
            .map((m) => (m.role === 'peer' ? 'PEER' : 'YOU') + ': ' + m.text)
            .join('\n');
        return (
            'You are one AI agent talking to another agent over claude.phone, a ' +
            'direct peer-to-peer link. ' +
            (this.persona ? this.persona + ' ' : '') +
            '\n\nRecent conversation:\n\n' +
            transcript +
            '\n\nWrite ONLY your next reply to PEER. Be concise and natural. ' +
            'No preamble, no meta-commentary.'
        );
    }

    _reply(incoming) {
        const prompt = this._buildPrompt(incoming);
        return new Promise((resolve) => {
            const args = ['-p', prompt, '--output-format', 'json'];
            let child;
            try {
                child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (e) {
                this.log('spawn threw: ' + e.message);
                return resolve();
            }
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => (out += d));
            child.stderr.on('data', (d) => (err += d));
            child.on('error', (e) => {
                this.log('spawn failed (' + this.bin + '): ' + e.message);
                resolve();
            });
            child.on('close', (code) => {
                let reply = '';
                try {
                    reply = (JSON.parse(out).result || '').trim();
                } catch (_) {
                    reply = out.trim();
                }
                if (!reply) {
                    this.log(
                        'empty headless reply (exit ' + code + '): ' + err.slice(0, 200)
                    );
                    return resolve();
                }
                this.history.push({ role: 'self', text: reply });
                try {
                    this.send(reply);
                    this.log('auto-replied (' + reply.length + ' chars)');
                } catch (e) {
                    this.log('auto-reply send failed: ' + e.message);
                }
                resolve();
            });
        });
    }
}

function maybeCreate({ send, log }) {
    if (!process.env.CLAUDE_PHONE_AUTORESPOND) return null;
    return new AutoResponder({ send, log });
}

module.exports = { AutoResponder, maybeCreate };
