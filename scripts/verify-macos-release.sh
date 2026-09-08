#!/usr/bin/env bash
# Validate the built artifact, never infer signing status from secret presence.
# Outputs are safe key=value lines for GITHUB_OUTPUT. No signing identity is logged.
set -euo pipefail

APP=${1:?app bundle path required}
MODE=${2:?expected signing mode required}
NOTARIZE=${3:-false}
case "$MODE:$NOTARIZE" in
  adhoc:false|developer-id:false|developer-id:true) ;;
  *) echo "Invalid signing/notarization mode." >&2; exit 1 ;;
esac

codesign --verify --deep --strict "$APP"
DETAILS=$(codesign --display --verbose=4 "$APP" 2>&1)
if [ "$MODE" = adhoc ]; then
  grep -q '^Signature=adhoc$' <<< "$DETAILS" || {
    echo "Expected an ad-hoc signature; refusing to publish misleading metadata." >&2
    exit 1
  }
else
  grep -q '^Authority=Developer ID Application:' <<< "$DETAILS" || {
    echo "Expected a Developer ID Application signature." >&2
    exit 1
  }
fi

if [ "$NOTARIZE" = true ]; then
  xcrun stapler validate "$APP" >/dev/null
  spctl --assess --type execute "$APP"
fi
printf 'signing=%s\nnotarized=%s\n' "$MODE" "$NOTARIZE"
