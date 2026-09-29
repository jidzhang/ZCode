@echo off
rem SKIP-BUILD package: reuse compiled outputs, repackage tar.gz + NSIS installer
cd /d %~dp0
rem Production identity: installer overwrites official build (ZCode, no Preview/_TEST)
set ZCODE_ENV=production
set ZCODE_PREVIEW_IDENTITY=0
rem Official channel: updater fully disabled by code (no auto, no manual); daily builds stay silent.
set ZCODE_UPDATE_CHANNEL=official
rem NOTE: pnpm on Windows is pnpm.cmd, must use CALL or the script never returns here
call pnpm run build:zcode --skip-build --base-url http://localhost/zcode/ %*
if errorlevel 1 goto :fail
node packages/desktop/scripts/bundle.mjs --os win --arch x64 --skip-build %*
if errorlevel 1 goto :fail
echo.
echo DONE. tar.gz in dist\zcode\releases\ , installer in packages\desktop\dist\
goto :end
:fail
echo.
echo BUILD FAILED
:end
PAUSE
