@echo off
rem Restricted-network wrapper for one-click-build-github.bat.
rem Sets binary download mirrors/proxy env so electron and electron-builder can
rem fetch their binaries on networks where github is not reachable; then calls
rem the regular github-channel build. pnpm must be installed manually beforehand
rem (repo pins pnpm@10.33.2, see package.json "packageManager").
rem
rem The proxy address is NOT stored in this repo. It is loaded once per machine
rem from one-click-build-local.env.bat (gitignored). Create it with:
rem   echo set BUILD_PROXY=http://your-proxy:8080> one-click-build-local.env.bat
rem
rem NOTE: keep this file ASCII-only; cmd parses .bat in the ANSI codepage (GBK)
rem and UTF-8 Chinese comments corrupt line parsing.
setlocal
cd /d %~dp0

if exist "%~dp0one-click-build-local.env.bat" (
  call "%~dp0one-click-build-local.env.bat"
) else (
  echo Missing one-click-build-local.env.bat ^(gitignored, not committed^) that
  echo defines BUILD_PROXY. Create it once with:
  echo   echo set BUILD_PROXY=http://your-proxy:8080^> one-click-build-local.env.bat
  goto :fail
)

if "%BUILD_PROXY%"=="" goto :no_proxy

set HTTPS_PROXY=%BUILD_PROXY%
set HTTP_PROXY=%BUILD_PROXY%
set ELECTRON_GET_USE_PROXY=1
set GLOBAL_AGENT_HTTPS_PROXY=%BUILD_PROXY%
set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/

call pnpm --version >nul 2>&1
if errorlevel 1 goto :no_pnpm

rem Fresh clone bootstrap: build-zcode consumes root packages\* dist outputs that
rem only "pnpm run typecheck" (tsc -b) produces. One-time; incremental afterwards.
if not exist "packages\shared\dist" (
  echo Fresh clone detected: building workspace packages via pnpm run typecheck ...
  call pnpm run typecheck
  if errorlevel 1 goto :fail_typecheck
)

echo Env ready (proxy=%BUILD_PROXY%). First run downloads electron 41.0.3 + NSIS +
echo winCodeSign via the mirror (about 10 extra minutes); later runs reuse cache.
echo Starting one-click-build-github.bat ...
echo.
call one-click-build-github.bat
goto :end

:no_proxy
echo one-click-build-local.env.bat exists but does not define BUILD_PROXY.
goto :fail
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
