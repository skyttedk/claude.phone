@echo off
REM Double-click to open the Claude layout chooser in THIS folder.
REM Copy into any dev folder -- it passes its own location to start.claude.ps1.
set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -File "G:\Mit drev\Claude\Setup\start.claude.ps1" "%DIR%"
