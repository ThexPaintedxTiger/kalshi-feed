@echo off
rem Start the live daemon and keep it running (Windows). Close the window to stop.
rem Auto-restarts if the daemon exits; pulls new code before each start.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22+ is required: https://nodejs.org & pause & exit /b 1)
if not exist local mkdir local
set WAIT=5
:loop
if not "%NO_PUSH%"=="1" git pull --rebase -q 2>nul
node live\daemon.mjs
if %ERRORLEVEL%==0 (echo daemon stopped cleanly & exit /b 0)
echo %DATE% %TIME% daemon exited (%ERRORLEVEL%); restarting in %WAIT%s >> local\daemon.log
echo daemon exited; restarting in %WAIT%s
timeout /t %WAIT% /nobreak >nul
if %WAIT% LSS 60 set /a WAIT=WAIT*2
goto loop
