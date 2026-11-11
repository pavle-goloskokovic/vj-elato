@echo off
rem VJ Elato: serve this folder on http://localhost:8765/ and open it.
rem Uses the embeddable Python in .\python if make_portable.py put it there,
rem otherwise an installed Python.
cd /d "%~dp0"
if exist "%~dp0python\python.exe" (
  "%~dp0python\python.exe" "%~dp0serve.py" 8765
  goto :eof
)
where python >nul 2>&1
if %errorlevel%==0 (
  python "%~dp0serve.py" 8765
) else (
  echo No Python found. Run make_portable.py from the repo once to bundle it, or install Python 3.
  pause
)
