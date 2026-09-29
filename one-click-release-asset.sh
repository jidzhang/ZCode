#!/usr/bin/env bash
# Release one more platform asset to the existing Release (no tagging, no pushing).
# Usage: ./one-click-release-asset.sh <win|linux|mac> <x64|arm64>
#   ./one-click-release-asset.sh linux x64      (Debian x64)
#   ./one-click-release-asset.sh mac x64        (Intel Mac)
# Tree must already be checked out at the release tag on this machine.
# Publishing machine needs: gh auth login (once), same env below.
set -u
cd "$(dirname "$0")"

if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Usage: one-click-release-asset.sh <win|linux|mac> <x64|arm64>"
  exit 1
fi

# Production identity so the installer overwrites the official build.
export ZCODE_ENV=production
export ZCODE_PREVIEW_IDENTITY=0
# Self-hosted update channel (must match the first-platform build).
export ZCODE_UPDATE_CHANNEL=github
export ZCODE_UPDATE_GITHUB_REPO="${ZCODE_UPDATE_GITHUB_REPO:-jidzhang/ZCode}"

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI (gh) not found in PATH."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in. Run: gh auth login"; exit 1; }

GH_TOKEN="$(gh auth token)" || true
export GH_TOKEN
if [ -z "${GH_TOKEN}" ]; then
  echo "Cannot derive GH_TOKEN from gh auth token."
  exit 1
fi

node packages/desktop/scripts/bundle.mjs --os "$1" --arch "$2" --publish always || {
  echo "RELEASE FAILED"
  exit 1
}

echo "DONE. Asset uploaded to the existing Release; no new Release created."
echo "Check the Release page, then install and verify on that platform."
