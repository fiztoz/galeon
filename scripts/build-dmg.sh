#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Ad-hoc signing needs no certificate or keychain changes.
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"

PKG_VERSION=$(node -p "require('./package.json').version")
CARGO_VERSION=$(grep -E '^version = ' src-tauri/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/')
TAURI_VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")

if [[ "$PKG_VERSION" != "$CARGO_VERSION" || "$PKG_VERSION" != "$TAURI_VERSION" ]]; then
  echo "Version mismatch detected:"
  echo "  package.json:      $PKG_VERSION"
  echo "  Cargo.toml:        $CARGO_VERSION"
  echo "  tauri.conf.json:   $TAURI_VERSION"
  exit 1
fi

echo "Building Galeon $PKG_VERSION (universal macOS .dmg)"
echo ""
echo "Ensure you have the required targets installed via rustup:"
echo "  rustup target add aarch64-apple-darwin x86_64-apple-darwin"
echo ""

bun install --frozen-lockfile
bun tauri build --target universal-apple-darwin -- --locked