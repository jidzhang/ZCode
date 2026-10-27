@echo off
rem Restricted-network wrapper for one-click-build-github.bat.
rem Binary downloads (electron, NSIS, winCodeSign) need a proxy plus npmmirror
rem mirrors on networks where github is not reachable; with direct internet
rem access the default sources work as-is.
rem
rem Proxy is NOT stored in this repo. Per machine, copy
rem one-click-build-local.env.example.bat to one-click-build-local.env.bat
rem (gitignored) and fill in BUILD_PROXY. If the file is missing or BUILD_PROXY
rem is empty, this wrapper runs in direct-connection mode (no proxy, default
rem download sources).
rem
rem pnpm must be installed manually beforehand (repo pins pnpm@10.33.2, see
rem package.json "packageManager").
rem
rem NOTE: keep this file ASCII-only; cmd parses .bat in the ANSI codepage (GBK)
rem and UTF-8 Chinese comments corrupt line parsing.
setlocal
cd /d %~dp0

set "BUILD_PROXY="
if not exist "%~dp0one-click-build-local.env.bat" goto :no_env
call "%~dp0one-click-build-local.env.bat"
goto :after_env

:no_env
echo one-click-build-local.env.bat not found - direct-connection mode
echo ^(no proxy, default download sources^). Need a proxy? Copy
echo one-click-build-local.env.example.bat and fill in BUILD_PROXY.
echo.

:after_env

if "%BUILD_PROXY%"=="" goto :direct_env

set HTTPS_PROXY=%BUILD_PROXY%
set HTTP_PROXY=%BUILD_PROXY%
set ELECTRON_GET_USE_PROXY=1
set GLOBAL_AGENT_HTTPS_PROXY=%BUILD_PROXY%
set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
echo Env ready (proxy=%BUILD_PROXY%). First run downloads electron 41.0.3 + NSIS +
echo winCodeSign via the mirror (about 10 extra minutes); later runs reuse cache.
goto :prep

:direct_env
echo Direct-connection mode: default download sources ^(github^) will be used.
goto :prep

:prep
call pnpm --version >nul 2>&1
if errorlevel 1 goto :no_pnpm

call pnpm install
rem Fresh clone bootstrap: build-zcode consumes root packages\* dist outputs that
rem only "pnpm run typecheck" (tsc -b) produces. One-time; incremental afterwards.
rem Probe several dists so a partially built tree still triggers the bootstrap.
if not exist "packages\shared\dist" goto :bootstrap_typecheck
if not exist "packages\client\dist" goto :bootstrap_typecheck
if not exist "packages\ui\dist" goto :bootstrap_typecheck
goto :run

:bootstrap_typecheck
echo Fresh or partially built clone detected: building workspace packages via pnpm run typecheck ...
call pnpm run typecheck
if errorlevel 1 goto :fail_typecheck

:run
echo Starting one-click-build-github.bat ...
echo.
call one-click-build-github.bat
rem The child ends with PAUSE so a human can read the result. Return here only
rem once: do not fall through to any build label after the keypress.
exit /b %errorlevel%

:no_pnpm
echo pnpm not found in PATH. Install it manually first:
echo   npm i -g pnpm@10.33.2 --force
echo then verify with: pnpm --version
goto :fail
:fail_typecheck
echo.
echo Workspace bootstrap (pnpm run typecheck) failed. Fix the errors above,
echo then run this script again.
goto :fail
:fail
echo.
echo BUILD PREP FAILED
PAUSE
:end
