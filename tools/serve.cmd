@echo off
rem VJ Elato launcher (Windows). Works from any folder on any drive: clips, cache and logs
rem live in this folder (clips\, clips\cache\, logs\).
rem
rem From a removable drive the tool is first copied to this user's local app data and run from
rem there, so pulling the drive cannot kill the server: only the clips, the cache and a copy of
rem the log stay on the drive, and the server reports when it is gone and recovers when it is
rem back. Every launch re-copies, so updating the drive is the update. From a fixed disk the
rem tool runs where it is and leaves nothing elsewhere.
rem   serve.cmd --stage      copy to the laptop first, whatever the drive
rem   serve.cmd --no-stage   never copy
rem Extra options for serve.py (see its first lines) go in the VJ_ELATO_ARGS variable.
setlocal
set "SRC=%~dp0"
set "STAGE="
if /i "%~1"=="--stage" set "STAGE=1"
if /i "%~1"=="--no-stage" goto :run_here
if not defined STAGE (
  fsutil fsinfo drivetype %~d0 2>nul | find /i "Removable" >nul && set "STAGE=1"
)
if not defined STAGE goto :run_here

set "RUN=%LOCALAPPDATA%\vj-elato\run"
echo Copying the tool to %RUN% ...
robocopy "%SRC%." "%RUN%" /MIR /XD clips logs /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul
if errorlevel 8 (
  echo Could not copy the tool to the laptop; running from the drive instead.
  goto :run_here
)
cd /d "%RUN%"
if exist "%RUN%\python\python.exe" (
  "%RUN%\python\python.exe" "%RUN%\serve.py" 8765 --home "%SRC%." %VJ_ELATO_ARGS%
  goto :done
)
where python >nul 2>&1
if %errorlevel%==0 (
  python "%RUN%\serve.py" 8765 --home "%SRC%." %VJ_ELATO_ARGS%
) else (
  goto :no_python
)
goto :done

:run_here
cd /d "%SRC%"
if exist "%SRC%python\python.exe" (
  "%SRC%python\python.exe" "%SRC%serve.py" 8765 %VJ_ELATO_ARGS%
  goto :done
)
where python >nul 2>&1
if %errorlevel%==0 (
  python "%SRC%serve.py" 8765 %VJ_ELATO_ARGS%
) else (
  goto :no_python
)
goto :done

:no_python
echo No Python found. This copy came without the bundled one: install Python 3 from python.org,
echo or get the full zip.
pause
goto :eof

:done
if errorlevel 1 pause
