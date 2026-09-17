#!/usr/bin/env bash
# Builds demo/JevDemo/main.swift into demo/JevDemo/build/JevDemo.app and launches it.
# A native macOS animation of fast-jev-compaction inside a Claude Code-style
# terminal, meant to be screen recorded. Press space in the app to replay.
set -euo pipefail

cd "$(dirname "$0")"
app=build/JevDemo.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp Info.plist "$app/Contents/"
swiftc -O -parse-as-library \
  -target "$(uname -m)-apple-macos14.0" \
  -framework AppKit -framework SwiftUI \
  main.swift -o "$app/Contents/MacOS/JevDemo"
codesign --force --sign - "$app" >/dev/null 2>&1 || true

if [[ "${1:-}" != "--no-launch" ]]; then
  open "$app"
fi
