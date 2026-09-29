@echo off
rem One-click self release: tag + push + bundle + publish to own GitHub Releases.
rem Version is code-driven (root package.json); never hand-written.
rem First release was manual; this bat is for later versions.
setlocal
cd /d %~dp0

rem Production identity so the installer overwrites the official build.
set ZCODE_ENV=production
set ZCODE_PREVIEW_IDENTITY=0
rem Self-hosted update channel (daily builds stay on official by default).
set ZCODE_UPDATE_CHANNEL=github
if "%ZCODE_UPDATE_GITHUB_REPO%"=="" set ZCODE_UPDATE_GITHUB_REPO=jidzhang/ZCode

where gh >nul 2>&1
if errorlevel 1 goto :no_gh
gh auth status >nul 2>&1
if errorlevel 1 goto :no_auth

rem Read version from package.json (single source of truth).
for /f "tokens=*" %%v in ('node -p "require('./package.json').version"') do set APP_VERSION=%%v
if "%APP_VERSION%"=="" goto :no_version
set TAG=v%APP_VERSION%
echo Release tag: %TAG%  repo: %ZCODE_UPDATE_GITHUB_REPO%

rem Refuse to republish an existing tag (bump root package.json first).
git rev-parse -q --verify refs/tags/%TAG% >nul 2>&1
if %errorlevel%==0 goto :tag_exists

git tag -a %TAG% -m "safe-zcode self release %TAG%"
if errorlevel 1 goto :fail
git push origin main
if errorlevel 1 goto :fail
git push origin %TAG%
if errorlevel 1 goto :fail

for /f "tokens=*" %%t in ('gh auth token') do set GH_TOKEN=%%t
if "%GH_TOKEN%"=="" goto :no_token

node packages/desktop/scripts/bundle.mjs --os win --arch x64 --publish always %*
if errorlevel 1 goto :fail

echo.
echo DONE. Check the draft Release on GitHub and click Publish.
echo Install the exe from dist and verify per local-notes/release-win-x64-safe1.md
goto :end

:no_gh
echo GitHub CLI (gh) not found in PATH.
goto :fail
:no_auth
echo gh is not logged in. Run: gh auth login
goto :fail
:no_version
echo Cannot read version from package.json.
goto :fail
:tag_exists
echo Tag %TAG% already exists. Bump root package.json version first.
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
