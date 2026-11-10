#!/bin/bash
# Builds oneweek.app and packs it into dist/oneweek-<version>.dmg.
#
# Signed with the Apple Development certificate in project.yml, not notarized:
# on another Mac, allow it once in System Settings > Privacy & Security >
# Open Anyway. Needs Xcode and xcodegen (brew install xcodegen).
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(sed -n 's/.*MARKETING_VERSION: "\(.*\)"/\1/p' project.yml)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

xcodegen generate --quiet
xcodebuild -project Oneweek.xcodeproj -scheme Oneweek -configuration Release \
  -derivedDataPath "$WORK/build" -destination 'generic/platform=macOS' build -quiet

APP="$WORK/build/Build/Products/Release/oneweek.app"
codesign --verify --deep --strict "$APP"

mkdir -p "$WORK/dmg" dist
ditto "$APP" "$WORK/dmg/oneweek.app"
ln -s /Applications "$WORK/dmg/Applications"
OUT="dist/oneweek-$VERSION.dmg"
rm -f "$OUT"
hdiutil create -quiet -volname oneweek -srcfolder "$WORK/dmg" -format UDZO "$OUT"
echo "$PWD/$OUT"
