@echo off
rem GitHub-channel build (no publish): test self-hosted update channel locally.
rem This is the standard local build entry; releases go through GitHub Actions CI.
cd /d %~dp0
rem Production identity: installer overwrites official build (ZCode, no Preview/_TEST)
set ZCODE_ENV=production
set ZCODE_PREVIEW_IDENTITY=0
rem Self-hosted update channel: manual check hits own Releases;
rem auto check additionally needs auto-download ON in settings.
set ZCODE_UPDATE_CHANNEL=github
if "%ZCODE_UPDATE_GITHUB_REPO%"=="" set ZCODE_UPDATE_GITHUB_REPO=jidzhang/ZCode
rem Turborepo phones home to telemetry.vercel.com after each run; keep builds offline-clean.
set TURBO_TELEMETRY_DISABLED=1
rem NOTE: pnpm on Windows is pnpm.cmd, must use CALL or the script never returns here
call pnpm run build:zcode --base-url http://localhost/zcode/ %*
if errorlevel 1 goto :fail
node packages/desktop/scripts/bundle.mjs --os win --arch x64 %*
if errorlevel 1 goto :fail
echo.
echo DONE. tar.gz in dist\zcode\releases\ , installer in packages\desktop\dist\
echo This is a github-channel build. Publish via GitHub Actions (push the version tag).
goto :end
:fail
echo.
echo BUILD FAILED
:end
PAUSE
