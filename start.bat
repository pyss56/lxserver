@echo off
setlocal
title LX Music Sync Server - Dev

rem ------------------------------------------------------------
rem  Local development launcher for LX Music Sync Server
rem  Usage: start.bat [test|help]
rem  ASCII-only on purpose: avoids Windows console codepage issues.
rem ------------------------------------------------------------

cd /d "%~dp0"

if /i "%~1"=="help" goto :usage
if /i "%~1"=="/?" goto :usage
if /i "%~1"=="-h" goto :usage
if /i "%~1"=="test" goto :check_env
if not "%~1"=="" (
  echo [ERROR] Unknown argument: %~1
  echo         Run "start.bat help" for usage.
  exit /b 1
)

:check_env
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node.js 22.13.0 or newer from https://nodejs.org/
  goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH.
  goto :fail
)

for /f "tokens=*" %%i in ('node -v') do set "NODE_FULL=%%i"
set "NODE_VER=%NODE_FULL:v=%"
for /f "tokens=1,2 delims=." %%a in ("%NODE_VER%") do (
  set "N_MAJOR=%%a"
  set "N_MINOR=%%b"
)
if not defined N_MAJOR goto :bad_version
if not defined N_MINOR goto :bad_version
if %N_MAJOR% LSS 22 goto :bad_version
if %N_MAJOR% EQU 22 if %N_MINOR% LSS 13 goto :bad_version

if not exist "node_modules\tsx\package.json" (
  echo [INFO] Dependencies are missing. Running "npm ci" ...
  call npm ci
  if errorlevel 1 goto :fail
)

if not defined NODE_ENV set "NODE_ENV=development"
if not defined PORT set "PORT=9527"

if /i "%~1"=="test" (
  echo [INFO] Running the test suite: npm test
  call npm test
  if errorlevel 1 goto :fail
  echo [OK] Test suite passed.
  goto :done
)

echo.
echo [INFO] Starting the development server with "npm run dev".
echo        Player   : http://localhost:%PORT%/
echo        Admin    : http://localhost:%PORT%/admin
echo        Subsonic : http://localhost:%PORT%/rest
echo.
echo        Set PORT, DATA_PATH, CONFIG_PATH, ADMIN_PASSWORD before launch
echo        to override defaults. Press Ctrl+C to stop the server.
echo        Note: predev rewrites public/js/config.js (version + buildHash).
echo.
call npm run dev
if errorlevel 1 goto :fail
goto :done

:usage
echo Usage: start.bat [test^|help]
echo.
echo   start.bat         Start the dev server (npm run dev, nodemon + tsx).
echo   start.bat test    Run the test suite (npm test) and exit.
echo   start.bat help    Show this message.
echo.
echo Requirements : Node.js 22.13.0+ and npm.
echo First run    : installs dependencies with "npm ci".
echo Default port : 9527 (override with PORT).
echo Overrides    : NODE_ENV, PORT, BIND_IP, DATA_PATH, CONFIG_PATH,
echo                STATIC_PATH, ADMIN_PASSWORD.
echo Production   : npm run build then npm start (not handled here).
echo.
exit /b 0

:bad_version
echo [ERROR] Node.js %NODE_FULL% is too old.
echo         This project requires Node.js 22.13.0 or newer.
goto :fail

:fail
echo.
echo [FAILED] Check the output above for details.
pause
exit /b 1

:done
endlocal
exit /b 0
