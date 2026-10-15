@echo off
REM Installs (first time) and starts backend + frontend in two windows.
set BACKEND=F:\ITWORKS\WORK FLOW\LIVE\Node_Progovex
set FRONTEND=F:\ITWORKS\WORK FLOW\LIVE\LATEST\WORKFLOW_FRONTEND

if not exist "%BACKEND%\node_modules\mediasoup" (
  echo Installing backend packages...
  pushd "%BACKEND%"
  call npm install
  popd
)
if not exist "%FRONTEND%\node_modules\mediasoup-client" (
  echo Installing frontend packages...
  pushd "%FRONTEND%"
  call npm install
  popd
)

start "Backend" cmd /k "cd /d "%BACKEND%" && npm run dev"
start "Frontend" cmd /k "cd /d "%FRONTEND%" && npm start"
echo Backend and frontend are starting in two new windows.
echo Open http://localhost:4200 when the frontend says it is ready.
pause
