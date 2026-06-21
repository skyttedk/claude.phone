#!/usr/bin/env node
'use strict';
/**
 * Architecture A — blocking watcher.
 *
 * Run this in the BACKGROUND from a Claude Code session. It blocks (cheaply, in
 * a plain Node process — zero model tokens) until claude.phone has unread peer
 * messages, then exits 0. The Claude Code harness re-invokes the agent when a
 * backgrounded command finishes, so this exit IS the "onmessage" event: the
 * agent wakes, drains p2p_inbox, replies, and relaunches the watcher.
 *
 * Reads the same pending.json the MCP server writes (see src/state.js).
 *
 * Env:
 *   CLAUDE_PHONE_STATE_DIR        where pending.json lives (must match server)
 *   CLAUDE_PHONE_POLL_MS          file-check interval, default 500ms
 *   CLAUDE_PHONE_WAIT_TIMEOUT_MS  optional max wait; 0 = block forever (default)
 *
 * Exit output (stdout):
 *   MESSAGES:<n>   n unread messages are waiting
 *   TIMEOUT        timed out with nothing pending
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR =
    process.env.CLAUDE_PHONE_STATE_DIR || path.join(os.tmpdir(), 'claude-phone');
const PENDING = path.join(STATE_DIR, 'pending.json');
const INTERVAL = Number(process.env.CLAUDE_PHONE_POLL_MS || 500);
const TIMEOUT = Number(process.env.CLAUDE_PHONE_WAIT_TIMEOUT_MS || 0);
const start = Date.now();

function pendingCount() {
    try {
        const arr = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
        return Array.isArray(arr) ? arr.length : 0;
    } catch (_) {
        return 0; // missing or mid-write file -> treat as empty, retry next tick
    }
}

(function loop() {
    const n = pendingCount();
    if (n > 0) {
        process.stdout.write('MESSAGES:' + n + '\n');
        process.exit(0);
    }
    if (TIMEOUT && Date.now() - start > TIMEOUT) {
        process.stdout.write('TIMEOUT\n');
        process.exit(0);
    }
    setTimeout(loop, INTERVAL);
})();
