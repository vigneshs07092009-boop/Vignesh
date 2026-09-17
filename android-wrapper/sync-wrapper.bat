@echo off
setlocal
title Aevion - Sync native wrapper files

rem ============================================================
rem  Two copies of this project exist on this PC:
rem
rem    repo copy   C:\Users\vigne\OneDrive\Documents\GitHub\Vignesh\android-wrapper
rem    build copy  C:\Users\vigne\aevion-android        (where APKs are built)
rem
rem  This keeps the HAND-WRITTEN files identical in both, whichever
rem  side you edited, then tells you what git wants to commit.
rem  Generated folders (node_modules, www, build, .gradle) are never touched.
rem  Run it from either folder.
rem ============================================================

set "PROJ=%~dp0"
if "%PROJ:~-1%"=="\" set "PROJ=%PROJ:~0,-1%"

set "BUILD=C:\Users\vigne\aevion-android"
set "REPO=%PROJ%"
if /i "%PROJ%"=="%BUILD%" set "REPO=C:\Users\vigne\OneDrive\Documents\GitHub\Vignesh\android-wrapper"

echo.
echo   build copy : %BUILD%
echo   repo copy  : %REPO%
echo.
pause

if not exist "%BUILD%\android\app\src\main\java\com\aevion\app\SpeechPlugin.java" (
  echo  ERROR: no SpeechPlugin.java under "%BUILD%"
  echo  Edit the BUILD= line above if your build folder moved.
  pause
  exit /b 1
)
if not exist "%REPO%\android\app\src\main\java\com\aevion\app\SpeechPlugin.java" (
  echo  ERROR: no SpeechPlugin.java under "%REPO%"
  echo  Edit the REPO= logic above if your repo moved.
  pause
  exit /b 1
)

rem /XO = copy only files newer than the destination, so running both
rem directions makes the newer copy win and leaves identical files alone.

echo [1/4] Java sources        build -^> repo
robocopy "%BUILD%\android\app\src\main\java" "%REPO%\android\app\src\main\java" /E /XO /NFL /NDL /NJH /NJS /NP >nul
echo [2/4] Java sources        repo -^> build
robocopy "%REPO%\android\app\src\main\java" "%BUILD%\android\app\src\main\java" /E /XO /NFL /NDL /NJH /NJS /NP >nul
echo [3/4] Manifest + config   both ways
robocopy "%BUILD%\android\app\src\main" "%REPO%\android\app\src\main" AndroidManifest.xml /XO /NFL /NDL /NJH /NJS /NP >nul
robocopy "%REPO%\android\app\src\main" "%BUILD%\android\app\src\main" AndroidManifest.xml /XO /NFL /NDL /NJH /NJS /NP >nul
robocopy "%BUILD%" "%REPO%" capacitor.config.json /XO /NFL /NDL /NJH /NJS /NP >nul
robocopy "%REPO%" "%BUILD%" capacitor.config.json /XO /NFL /NDL /NJH /NJS /NP >nul
echo [4/4] Helper scripts       both ways
for %%F in (build-apk.ps1 verify-apk.ps1 update-and-rebuild.bat) do (
  robocopy "%BUILD%" "%REPO%" %%F /XO /NFL /NDL /NJH /NJS /NP >nul
  robocopy "%REPO%" "%BUILD%" %%F /XO /NFL /NDL /NJH /NJS /NP >nul
)

echo.
echo  Synced. What git sees in the repo copy:
cd /d "%REPO%\.."
git status --short -- android-wrapper
echo.
echo  Commit it with:
echo    git add android-wrapper ^&^& git commit -m "Update native wrapper"
echo.
pause
exit /b 0
