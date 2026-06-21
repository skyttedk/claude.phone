#!/usr/bin/env node
'use strict';
/**
 * Zero-token desktop notifier for claude.phone.
 *
 * The MCP server mirrors every inbound peer message to pending.json (src/state.js)
 * the instant it arrives — in-process and event-driven, with no model involvement.
 * This daemon polls that file and fires an OS notification on each new message, so
 * a human is alerted in real time WITHOUT ever waking the agent loop (no tokens).
 *
 * It is NOT a Claude Code hook (those only fire on Claude-Code lifecycle events,
 * never on message arrival). Run it once per session, in the background:
 *
 *   node scripts/notify-loop.js          # foreground, Ctrl-C to stop
 *   ! node scripts/notify-loop.js        # from the Claude prompt, backgrounded
 *
 * Env:
 *   CLAUDE_PHONE_STATE_DIR      where pending.json lives (default <tmp>/claude-phone)
 *   CLAUDE_PHONE_NOTIFY_POLL_MS poll interval, default 2000
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const STATE_DIR =
    process.env.CLAUDE_PHONE_STATE_DIR || path.join(os.tmpdir(), 'claude-phone');
const PENDING = path.join(STATE_DIR, 'pending.json');
const POLL_MS = Number(process.env.CLAUDE_PHONE_NOTIFY_POLL_MS || 2000);

function readPending() {
    try {
        const raw = fs.readFileSync(PENDING, 'utf8').replace(/^﻿/, '');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return []; // missing/garbled file -> treat as empty, tolerate races
    }
}

/** Fire an OS notification, best-effort per platform; always ring the terminal. */
function notify(title, body) {
    // Terminal bell + banner works everywhere and needs no dependencies.
    process.stdout.write('\x07[claude.phone] ' + title + ' — ' + body + '\n');
    try {
        if (process.platform === 'win32') {
            // Windows balloon via NotifyIcon. Single-quote-escape for PowerShell.
            const t = String(title).replace(/'/g, "''");
            const b = String(body).replace(/'/g, "''");
            const ps =
                "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
                "$n=New-Object System.Windows.Forms.NotifyIcon;" +
                "$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;" +
                "$n.ShowBalloonTip(4000,'" + t + "','" + b + "','Info');" +
                "Start-Sleep -Milliseconds 4500;$n.Dispose()";
            spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
                stdio: 'ignore',
                detached: false,
            });
        } else if (process.platform === 'darwin') {
            const b = String(body).replace(/"/g, '\\"');
            const t = String(title).replace(/"/g, '\\"');
            spawn('osascript', ['-e', 'display notification "' + b + '" with title "' + t + '"'], {
                stdio: 'ignore',
            });
        } else {
            spawn('notify-send', [title, body], { stdio: 'ignore' });
        }
    } catch (_) {
        /* notification backend missing; the terminal bell already fired */
    }
}

// Baseline to the newest already-pending message so we don't re-announce a
// backlog on every restart; announce the backlog once as a single summary.
let lastSeenT = '';
const startup = readPending();
if (startup.length) {
    notify(startup.length + ' unread message(s)', 'Already waiting in your inbox.');
    lastSeenT = startup.reduce((m, x) => (x.t > m ? x.t : m), '');
}

console.log(
    '[claude.phone] notifier watching ' + PENDING + ' every ' + POLL_MS + 'ms. Ctrl-C to stop.'
);

setInterval(() => {
    const msgs = readPending();
    let maxT = lastSeenT;
    for (const m of msgs) {
        if (m && typeof m.t === 'string' && m.t > lastSeenT) {
            const preview = String(m.text || '').slice(0, 120);
            notify('New message from peer', preview);
            if (m.t > maxT) maxT = m.t;
        }
    }
    lastSeenT = maxT;
}, POLL_MS);
