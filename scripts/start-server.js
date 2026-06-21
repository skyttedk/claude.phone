#!/usr/bin/env node
'use strict';
/**
 * Bootstrap launcher — used as the plugin's MCP command.
 *
 * Claude Code plugins ship source only and never run `npm install`, but this
 * server needs the native `node-datachannel` module. So on first launch we
 * install dependencies into the plugin directory, then hand off to the server.
 * Uses only Node built-ins so it runs before any dependency exists.
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function depsPresent() {
    try {
        require.resolve('node-datachannel', { paths: [ROOT] });
        return true;
    } catch (_) {
        return false;
    }
}

if (!depsPresent()) {
    process.stderr.write(
        '[claude.phone] first run: installing dependencies (this can take a ' +
            'while; if the MCP server times out, just restart)...\n'
    );
    try {
        execSync('npm install --omit=dev', { cwd: ROOT, stdio: 'inherit' });
    } catch (e) {
        process.stderr.write(
            '[claude.phone] dependency install failed: ' +
                e.message +
                '\nRun `npm install` manually in ' +
                ROOT +
                '\n'
        );
        process.exit(1);
    }
}

// Hand off — requiring server.js runs its main().
require(path.join(ROOT, 'src', 'server.js'));
