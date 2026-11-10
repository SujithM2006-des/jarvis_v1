@echo off
rem Starts JARVIS: the brain (bridge + interface server) and its window.
rem   start-jarvis.bat        normal start
rem   start-jarvis.bat wake   started by "Hey Jarvis": greets you and listens straight away
rem
rem The window opens at once on the loading screen (scripts\splash.html, read
rem straight from disk), which shows progress and switches to JARVIS by itself
rem the moment the brain and the interface are both up.
cd /d "%~dp0"
set JARVIS_ACCOUNT_CONNECTORS=1

set "SPLASH=%~dp0scripts\splash.html"
set "SPLASH=file:///%SPLASH:\=/%"
if /i "%~1"=="wake" set "SPLASH=%SPLASH%?wake=1"

rem The brain, unless it is already running.
curl -s -o nul -m 2 http://127.0.0.1:8787/health || start "JARVIS brain" /min cmd /k "npm start -- --writes"

rem Own Chrome profile so these flags apply even when normal Chrome is open:
rem they stop Chrome pausing the page (and its microphone) when other windows cover it,
rem allow sound without a click, and put the voice model on the NVIDIA GPU.
start "" chrome --user-data-dir="%USERPROFILE%\.jarvis\face-profile" --app="%SPLASH%" --start-maximized --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --autoplay-policy=no-user-gesture-required --force_high_performance_gpu
