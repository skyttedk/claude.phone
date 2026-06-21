#!/usr/bin/env node
'use strict';
/**
 * Stop-hook companion to the watcher.
 *
 * Wired as a Claude Code `Stop` hook (see plugin hooks). Every time the agent
 * tries to end a turn, this checks for unread peer messages and, if any exist,
 * blocks the stop and tells the agent to drain them — so the session won't go
 * idle while a peer is waiting on a reply. This complements Architecture A: the
 * watcher wakes a parked session, this one prevents premature stops mid-chat.
 *
 * Reads pending.json (src/state.js). Emits the hook JSON on stdout.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR =
    process.env.CLAUDE_PHONE_STATE_DIR || path.join(os.tmpdir(), 'claude-phone');
const PENDING = path.join(STATE_DIR, 'pending.json');

function pending() {
    try {
        const arr = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

const msgs = pending();
if (msgs.length > 0) {
    process.stdout.write(
        JSON.stringify({
            decision: 'block',
            reason:
                '📨 ' +
                msgs.length +
                ' unread claude.phone message(s) from the peer. Call p2p_inbox to ' +
                'read them and p2p_send your reply before stopping.',
        })
    );
}
// else: emit nothing -> the turn stops normally.
