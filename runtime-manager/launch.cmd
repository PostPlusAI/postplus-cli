@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0postplus.ps1" %*
exit /b %ERRORLEVEL%
