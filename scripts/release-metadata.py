#!/usr/bin/env python3
"""Validate a release tag against the checked-out tree; emit safe Actions outputs."""
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

# SemVer numeric identifiers may not have leading zeroes.
NUMBER = r"(?:0|[1-9][0-9]*)"
PRE = rf"(?:{NUMBER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
TAG_PATTERN = re.compile(
    rf"v{NUMBER}\.{NUMBER}\.{NUMBER}(?P<pre>-{PRE}(?:\.{PRE})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


def release_metadata(tag: str, root: Path) -> dict[str, str]:
    match = TAG_PATTERN.fullmatch(tag)
    if match is None:
        raise ValueError("Release tag must be v followed by a valid SemVer version.")
    versions = [
        json.loads((root / "package.json").read_text())["version"],
        tomllib.loads((root / "src-tauri/Cargo.toml").read_text())["package"]["version"],
        json.loads((root / "src-tauri/tauri.conf.json").read_text())["version"],
    ]
    if any(version != tag[1:] for version in versions):
        raise ValueError("Release tag must match package.json, Cargo.toml and tauri.conf.json.")
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    return {"commit": commit, "prerelease": str(match["pre"] is not None).lower()}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: release-metadata.py <tag>")
        for key, value in release_metadata(sys.argv[1], Path.cwd()).items():
            print(f"{key}={value}")
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Release validation failed: {error}", file=sys.stderr)
        sys.exit(1)
