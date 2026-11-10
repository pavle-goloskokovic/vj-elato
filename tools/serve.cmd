@echo off
rem VJ Elato: serve this folder on http://localhost:8765/ and open it.
rem Uses Python if it is on the machine, otherwise a pure PowerShell server.
cd /d "%~dp0"
where python >nul 2>&1
if %errorlevel%==0 (
  python "%~dp0serve.py" 8765
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8765
)
