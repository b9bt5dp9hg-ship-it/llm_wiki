#!/bin/bash
# Install a locally built LLM Wiki.app into /Applications with a stable code signature.
#
# Why: `npm run tauri build` without a signing identity leaves the app ad-hoc
# (linker) signed, so its designated requirement is the cdhash of that one build.
# macOS (TCC) stores Full Disk Access with exactly that requirement. Every rebuild
# changes the cdhash: the switch in System Settings stays on, but access is denied
# ("Failed to match existing code requirement for subject com.llmwiki.app").
# Signing with a certificate makes the requirement "bundle ID + certificate",
# which survives rebuilds and upgrades.
#
# Usage: scripts/install-macos-app.sh [path/to/LLM Wiki.app]
#   default source        src-tauri/target/release/bundle/macos/LLM Wiki.app
#   LLMWIKI_DEST          target (default: /Applications/LLM Wiki.app)
#   LLMWIKI_SIGN_IDENTITY keychain identity (default: "Apple Development")
#   LLMWIKI_LAUNCH=0      neither quit the running app nor relaunch it
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
src="${1:-$repo/src-tauri/target/release/bundle/macos/LLM Wiki.app}"
dest="${LLMWIKI_DEST:-/Applications/LLM Wiki.app}"
identity="${LLMWIKI_SIGN_IDENTITY:-Apple Development}"
launch="${LLMWIKI_LAUNCH:-1}"
bundle_id="com.llmwiki.app"

[ -f "$src/Contents/Info.plist" ] || { echo "No app at $src" >&2; exit 2; }
actual_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$src/Contents/Info.plist")
[ "$actual_id" = "$bundle_id" ] || { echo "Bundle ID $actual_id, expected $bundle_id" >&2; exit 2; }

dir=$(dirname "$dest")
stage=$(mktemp -d "$dir/.llmwiki-install.XXXXXX")
trap 'rm -rf "$stage"' EXIT

ditto "$src" "$stage/LLM Wiki.app"
codesign --force --deep --timestamp=none --identifier "$bundle_id" --sign "$identity" "$stage/LLM Wiki.app"
codesign --verify --deep --strict "$stage/LLM Wiki.app"

requirement=$(codesign -d -r- "$stage/LLM Wiki.app" 2>&1 | sed -n 's/^#* *designated => //p')
case "$requirement" in
  "" | *cdhash*)
    echo "Signature is not stable (${requirement:-no requirement}); Full Disk Access would break on the next build." >&2
    exit 3 ;;
  "identifier \"$bundle_id\" and "*) ;;
  *)
    echo "Unexpected requirement: $requirement" >&2
    exit 3 ;;
esac

if [ "$launch" = 1 ]; then
  osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -f "$dest/Contents/MacOS/" >/dev/null || break
    sleep 0.5
  done
fi

if [ -d "$dest" ]; then mv "$dest" "$stage/previous.app"; fi
mv "$stage/LLM Wiki.app" "$dest"
echo "Installed: $dest"
echo "Requirement: $requirement"

if [ "$launch" = 1 ]; then open "$dest"; fi
