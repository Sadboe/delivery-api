@echo off
echo Installing dependencies...
call npm.cmd install
echo Starting Delivery API on http://localhost:3000
call npm.cmd start
pause
