#!/bin/bash
# Ensures the Apple WWDR G3 intermediate is installed so Development / Developer ID
# certificates can build a valid signing chain. Safe to run repeatedly.

ensure_macos_signing_chain() {
  if [[ "${APPLE_SIGNING_IDENTITY:-}" == "-" ]]; then
    return 0
  fi

  local identity_count
  identity_count=$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^[[:space:]]*\([0-9]*\) valid identities found.*/\1/p' \
    | head -1)

  if [[ -n "${identity_count:-}" && "${identity_count}" -gt 0 ]]; then
    return 0
  fi

  echo "No valid code signing identities found — installing Apple WWDR G3 intermediate..."
  local cer="/tmp/AppleWWDRCAG3.cer"
  curl -fsSL -o "$cer" "https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer"
  security import "$cer" -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign

  identity_count=$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^[[:space:]]*\([0-9]*\) valid identities found.*/\1/p' \
    | head -1)

  if [[ -z "${identity_count:-}" || "${identity_count}" -eq 0 ]]; then
    echo ""
    echo "Warning: no valid signing identities after installing WWDR G3."
    echo "For unsigned local builds: export APPLE_SIGNING_IDENTITY=-"
    echo ""
    return 0
  fi

  echo "Signing chain restored ($identity_count identity/identities available)."
  echo ""
}