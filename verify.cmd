@echo off
setlocal
chcp 65001 >nul
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" -Action verify
set "shareExitCode=%errorlevel%"
if not "%shareExitCode%"=="0" pause
exit /b %shareExitCode%
