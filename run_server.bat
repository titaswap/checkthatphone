@echo off
title CheckThatPhone Server
cd /d "e:\Automation\checkthatphone"
echo Starting Phone Validator Server...

:: Starts a background task to wait 2 seconds (to let Node.js start up) and then opens the browser
start "" cmd /c "timeout /t 2 >nul && start http://dev.checkthatphone.com:8888/"

npm start
pause
