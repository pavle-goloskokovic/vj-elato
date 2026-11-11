@echo off
rem VJ Elato launcher (Windows).
rem Copies the tool from the stick to this user's local app data and runs the server from
rem there, so pulling the stick cannot kill the server: only clips and the cache live on the
rem stick, and the server reports when it is gone and recovers when it is back. Every launch
rem re-copies, so updating the stick is the update. "serve.cmd --no-stage" runs from the
rem stick directly and leaves nothing on the laptop.
setlocal
set "SRC=%~dp0"
set "STICK=%~dp0.."
if /i "%~1"=="--no-stage" goto :run_here

set "RUN=%LOCALAPPDATA%\vj-elato\run"
echo Staging the tool to %RUN% ...
robocopy "%SRC%." "%RUN%" /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul
if errorlevel 8 (
  echo Could not copy the tool to the laptop; running from the stick instead.
  goto :run_here
)
cd /d "%RUN%"
if exist "%RUN%\python\python.exe" (
  "%RUN%\python\python.exe" "%RUN%\serve.py" 8765 --stick "%STICK%"
  goto :eof
)
where python >nul 2>&1
if %errorlevel%==0 (
  python "%RUN%\serve.py" 8765 --stick "%STICK%"
) else (
  echo No Python found. Run make_portable.py from the repo once to bundle it, or install Python 3.
  pause
)
goto :eof

:run_here
cd /d "%SRC%"
if exist "%SRC%python\python.exe" (
  "%SRC%python\python.exe" "%SRC%serve.py" 8765
  goto :eof
)
where python >nul 2>&1
if %errorlevel%==0 (
  python "%SRC%serve.py" 8765
) else (
  echo No Python found. Run make_portable.py from the repo once to bundle it, or install Python 3.
  pause
)
