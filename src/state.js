'use strict';
/**
 * Shared on-disk state bridge.
 *
 * The MCP server holds the live WebRTC channel in-process, but a background
 * watcher (Architecture A) and Stop hooks run as SEPARATE processes that
 * cannot call MCP tools. So inbound messages are mirrored to a small JSON file
 * those processes can poll. This is the bridge from the data channel into the
 * agent loop.
 *
 * Location: $CLAUDE_PHONE_STATE_DIR or <os tmp>/claude-phone. Both the server
 * and the watcher default to the same path, so they agree without config.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR =
    process.env.CLAUDE_PHONE_STATE_DIR || path.join(os.tmpdir(), 'claude-phone');
const PENDING_FILE = path.join(STATE_DIR, 'pending.json');

function ensureDir() {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
    } catch (_) {
        /* ignore */
    }
}

/** Mirror the current unread-message list to disk (atomic-ish via temp rename). */
function writePending(messages) {
    ensureDir();
    const tmp = PENDING_FILE + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
        fs.renameSync(tmp, PENDING_FILE);
    } catch (_) {
        /* best-effort; the watcher tolerates a missing/garbled file */
    }
}

function clearPending() {
    writePending([]);
}

module.exports = { STATE_DIR, PENDING_FILE, writePending, clearPending };
