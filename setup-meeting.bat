@echo off
REM Installs the meeting media server and opens its ports in Windows Firewall.
REM Right-click -> Run as administrator (needed for the firewall rules).
cd /d "%~dp0"
echo Installing backend packages (includes mediasoup)...
call npm install
if errorlevel 1 (echo npm install failed & pause & exit /b 1)
echo Opening media ports 40000-40031 (UDP+TCP)...
netsh advfirewall firewall add rule name="Meeting media UDP" dir=in action=allow protocol=UDP localport=40000-40031 >nul
netsh advfirewall firewall add rule name="Meeting media TCP" dir=in action=allow protocol=TCP localport=40000-40031 >nul
echo Done. Start the backend with: npm run dev
pause
