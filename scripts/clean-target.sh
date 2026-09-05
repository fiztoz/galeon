#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${PROJECT_ROOT}/src-tauri/target"

if [[ ! -d "${PROJECT_ROOT}/src-tauri" ]]; then
  echo "Error: src-tauri not found at ${PROJECT_ROOT}/src-tauri" >&2
  exit 1
fi

if [[ ! -d "${TARGET_DIR}" ]]; then
  echo "Nothing to clean: ${TARGET_DIR} does not exist."
  exit 0
fi

SIZE_BEFORE="$(du -sh "${TARGET_DIR}" | cut -f1)"
echo "Removing Rust target directory: ${TARGET_DIR} (${SIZE_BEFORE})"
rm -rf "${TARGET_DIR}"
echo "Done. Galeon target cache cleared."