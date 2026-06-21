@echo off
REM Architecture B: run claude.phone as an autonomous, self-answering endpoint.
REM Incoming peer messages are answered by a headless `claude -p` run and sent
REM back automatically -- no interactive session required.
REM
REM Optional: set CLAUDE_PHONE_PERSONA to frame the agent's voice, and
REM CLAUDE_PHONE_CLAUDE_BIN if the claude CLI is not on PATH.
set "DIR=%~dp0"
set "CLAUDE_PHONE_AUTORESPOND=1"
node "%DIR%src\server.js"
