@echo off
setlocal
title Aevion - Update and Rebuild APK

rem ---- where am I? this works from the repo copy or your build folder ----
set "PROJ=%~dp0"
if "%PROJ:~-1%"=="\" set "PROJ=%PROJ:~0,-1%"

rem ---- web app source: sibling ..\aevion in the repo, else the absolute path ----
set "SRC=%PROJ%\..\aevion"
if exist "%SRC%\index.html" goto :srcok
set "SRC=C:\Users\vigne\OneDrive\Documents\GitHub\Vignesh\aevion"
:srcok

rem ---- toolchain: edit these if you move the portable install ----
set "TOOLS=C:\Users\vigne\aevion-tools"
set "NODE=%TOOLS%\node-v22.14.0-win-x64"
set "JDK=%TOOLS%\jdk-21.0.12.1+1"
set "SDK=%TOOLS%\android-sdk"

set "DST=%PROJ%\www"
set "APK=%PROJ%\android\app\build\outputs\apk\debug\app-debug.apk"
set "OUT=C:\Users\vigne\OneDrive\Documents\Aevion.apk"

echo.
echo  AEVION APK BUILDER
echo  ==================
echo   project : %PROJ%
echo   web app : %SRC%
echo   output  : %OUT%
echo.
pause

if not exist "%SRC%\index.html" (
  echo  ERROR: Aevion web app not found at "%SRC%"
  echo  Edit the SRC= line in this file to point at your repo's aevion folder.
  pause
  exit /b 1
)
if not exist "%NODE%\npx.cmd" (
  echo  ERROR: portable Node.js not found at "%NODE%"
  echo  Edit the NODE= line in this file, or run "npm install" in %PROJ% yourself.
  pause
  exit /b 1
)
if not exist "%PROJ%\node_modules\@capacitor\cli" (
  echo  NOTE: Capacitor is not installed in this folder yet - running npm install...
  cd /d "%PROJ%"
  set "PATH=%NODE%;%PATH%"
  call "%NODE%\npm.cmd" install
  if errorlevel 1 goto :error
)

echo.
echo [1/3] Copying latest Aevion web app...
rem serve.* are PC-only launchers - they have no place inside the APK
robocopy "%SRC%" "%DST%" /E /XF serve.ps1 serve.bat /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :error

echo [2/3] Syncing Capacitor...
cd /d "%PROJ%"
set "PATH=%NODE%;%JDK%\bin;%PATH%"
call "%NODE%\npx.cmd" cap sync android
if errorlevel 1 goto :error

echo [3/3] Building APK (1-2 min the first time)...
call powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJ%\build-apk.ps1"
if errorlevel 1 goto :error

copy /Y "%APK%" "%OUT%" >nul
echo.
echo  DONE! Fresh APK: %OUT%
echo  Move it to your phone and install (allow "install unknown apps").
echo.
echo  Tip: run verify-apk.ps1 to confirm the plugin and assets really
echo       made it into the APK before you copy it over.
echo.
pause
exit /b 0

:error
echo.
echo  BUILD FAILED - check the messages above.
pause
exit /b 1
