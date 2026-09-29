@echo off
rem Release one more platform asset to the existing Release (no tagging, no pushing).
rem Usage: one-click-release-asset.bat ^<win^|linux^|mac^> ^<x64^|arm64^>
rem   one-click-release-asset.bat linux x64      (Debian x64)
rem   one-click-release-asset.bat win arm64      (Windows ARM)
rem   one-click-release-asset.bat mac x64        (Intel Mac)
rem Tree must already be checked out at the release tag on this machine.
rem Publishing machine needs: gh auth login (once), same env below.
setlocal
cd /d %~dp0

if "%~1"=="" goto :usage
if "%~2"=="" goto :usage

rem Production identity so the installer overwrites the official build.
set ZCODE_ENV=production
set ZCODE_PREVIEW_IDENTITY=0
rem Self-hosted update channel (must match the first-platform build).
set ZCODE_UPDATE_CHANNEL=github
if "%ZCODE_UPDATE_GITHUB_REPO%"=="" set ZCODE_UPDATE_GITHUB_REPO=jidzhang/ZCode

where gh >nul 2>&1
if errorlevel 1 goto :no_gh
gh auth status >nul 2>&1
if errorlevel 1 goto :no_auth

for /f "tokens=*" %%t in ('gh auth token') do set GH_TOKEN=%%t
if "%GH_TOKEN%"=="" goto :no_token

node packages/desktop/scripts/bundle.mjs --os %~1 --arch %~2 --publish always
if errorlevel 1 goto :fail

echo.
echo DONE. Asset uploaded to the existing Release; no new Release created.
echo Check the Release page, then install and verify on that platform.
goto :end

:usage
echo Usage: one-click-release-asset.bat ^<win^|linux^|mac^> ^<x64^|arm64^>
goto :fail
:no_gh
echo GitHub CLI (gh) not found in PATH.
goto :fail
:no_auth
echo gh is not logged in. Run: gh auth login
goto :fail
:no_token
echo Cannot derive GH_TOKEN from gh auth token.
goto :fail
:fail
echo.
echo RELEASE FAILED
:end
endlocal
PAUSE
