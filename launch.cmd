@echo off
setlocal
cd /d "%~dp0"
set "ADAMS_NODE=node.exe"
if exist "%ProgramFiles%\nodejs\node.exe" set "ADAMS_NODE=%ProgramFiles%\nodejs\node.exe"
"%ADAMS_NODE%" --env-file-if-exists=.env "%~dp0launcher.mjs"
if errorlevel 1 pause
