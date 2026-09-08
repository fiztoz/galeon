"""Release-policy regressions; no Apple keychains, network, or real signing needed."""
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_metadata", ROOT / "scripts/release-metadata.py")
METADATA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(METADATA)


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "src-tauri").mkdir()

    def declare(self, version):
        (self.root / "package.json").write_text(json.dumps({"version": version}))
        (self.root / "src-tauri/tauri.conf.json").write_text(json.dumps({"version": version}))
        (self.root / "src-tauri/Cargo.toml").write_text(f'[package]\nversion = "{version}"\n')

    def test_stable_prerelease_and_build_metadata(self):
        for version, prerelease in [
            ("1.0.0", "false"), ("1.0.0-alpha.3", "true"),
            ("1.0.0-rc.1+build.7", "true"), ("1.0.0+build-alpha", "false"),
        ]:
            with self.subTest(version=version):
                self.declare(version)
                with patch.object(METADATA.subprocess, "check_output", return_value="a" * 40 + "\n") as git:
                    result = METADATA.release_metadata("v" + version, self.root)
                self.assertEqual(result, {"commit": "a" * 40, "prerelease": prerelease})
                git.assert_called_once_with(["git", "rev-parse", "HEAD"], cwd=self.root, text=True)

    def test_invalid_or_injected_tags_are_rejected(self):
        for tag in ["main", "v1", "v01.0.0", "v1.0.0-alpha.01", "v1.0.0\nvalue=bad", "v1.0.0-$(id)", "../v1.0.0"]:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                METADATA.release_metadata(tag, self.root)

    def test_every_version_must_agree(self):
        self.declare("1.0.0")
        (self.root / "src-tauri/tauri.conf.json").write_text('{"version":"1.0.1"}')
        with self.assertRaisesRegex(ValueError, "must match"):
            METADATA.release_metadata("v1.0.0", self.root)


class SigningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bin = Path(self.temp.name)
        mocks = {
            "codesign": '#!/bin/sh\nif [ "$1" = --verify ]; then exit "${VERIFY_EXIT:-0}"; fi\nprintf "%s\\n" "$MOCK_SIGNATURE"\n',
            "xcrun": '#!/bin/sh\nexit "${STAPLER_EXIT:-0}"\n',
            "spctl": '#!/bin/sh\nexit "${ASSESS_EXIT:-0}"\n',
        }
        for name, content in mocks.items():
            path = self.bin / name
            path.write_text(content)
            path.chmod(0o700)

    def verify(self, mode="adhoc", notarized="false", **overrides):
        env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
               "MOCK_SIGNATURE": "Signature=adhoc", **overrides}
        return subprocess.run(
            ["bash", str(ROOT / "scripts/verify-macos-release.sh"), "Fixture.app", mode, notarized],
            env=env, capture_output=True, text=True, timeout=5,
        )

    def test_adhoc_is_never_labelled_notarized(self):
        result = self.verify(STAPLER_EXIT="99", ASSESS_EXIT="99")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "signing=adhoc\nnotarized=false\n")
        self.assertNotEqual(self.verify(notarized="true").returncode, 0)

    def test_signature_verification_failure_blocks_publication(self):
        result = self.verify(VERIFY_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_signing_modes_cannot_be_mislabelled(self):
        for mode, signature in [
            ("developer-id", "Signature=adhoc"),
            ("adhoc", "Authority=Developer ID Application: Example (EXAMPLE)"),
            ("developer-id", "Authority=Apple Development: Example (EXAMPLE)"),
        ]:
            with self.subTest(mode=mode, signature=signature):
                self.assertNotEqual(self.verify(mode, MOCK_SIGNATURE=signature).returncode, 0)

    def test_notarization_requires_both_ticket_and_gatekeeper_validation(self):
        signature = "Authority=Developer ID Application: Example (EXAMPLE)"
        for override in [{"STAPLER_EXIT": "1"}, {"ASSESS_EXIT": "1"}]:
            result = self.verify("developer-id", "true", MOCK_SIGNATURE=signature, **override)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
        result = self.verify("developer-id", "true", MOCK_SIGNATURE=signature)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "signing=developer-id\nnotarized=true\n")

    def test_developer_id_without_notarization_is_explicit(self):
        result = self.verify("developer-id", MOCK_SIGNATURE="Authority=Developer ID Application: Example (EXAMPLE)", STAPLER_EXIT="99")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "signing=developer-id\nnotarized=false\n")


class ProvenanceTests(unittest.TestCase):
    def test_release_ref_guard(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        guard_start = workflow.index("      - name: Require an annotated tag on main")
        run_start = workflow.index("        run: |\n", guard_start) + len("        run: |\n")
        lines = []
        for line in workflow[run_start:].splitlines():
            if line and not line.startswith("          "):
                break
            lines.append(line[10:])
        guard = "\n".join(lines)
        self.assertLess(guard_start, workflow.index("run: python3 scripts/release-metadata.py"))
        self.assertIn("persist-credentials: false", workflow)
        with tempfile.TemporaryDirectory() as directory:
            git = Path(directory) / "git"
            git.write_text('''#!/bin/sh
case "$1" in
  cat-file) echo "${TAG_TYPE:-tag}" ;;
  rev-parse)
    if [ "$2" = HEAD ]; then echo head; else echo "${TAG_COMMIT:-head}"; fi ;;
  merge-base) exit "${ANCESTOR_EXIT:-0}" ;;
  *) exit 99 ;;
esac
''')
            git.chmod(0o700)
            base_env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"], "TAG": "v1.0.0"}
            for override, success in [({}, True), ({"TAG_TYPE": "commit"}, False), ({"TAG_COMMIT": "other"}, False), ({"ANCESTOR_EXIT": "1"}, False)]:
                with self.subTest(override=override):
                    result = subprocess.run(["bash", "-c", guard], env={**base_env, **override}, capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)


@unittest.skipUnless(platform.system() == "Darwin", "real ad-hoc signing is macOS-only")
class MacSigningSmokeTests(unittest.TestCase):
    def test_real_adhoc_signature_and_tamper_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Fixture.app"
            executable = app / "Contents/MacOS/Fixture"
            executable.parent.mkdir(parents=True)
            # Copy bytes, not the system binary's SIP-protected filesystem flags.
            shutil.copyfile("/usr/bin/true", executable)
            executable.chmod(0o700)
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "org.example.galeon-signing-fixture",
                "CFBundleExecutable": "Fixture",
                "CFBundlePackageType": "APPL",
                "CFBundleVersion": "1",
            }))
            signed = subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(app)], capture_output=True, text=True, timeout=30)
            self.assertEqual(signed.returncode, 0, signed.stderr)
            command = ["bash", str(ROOT / "scripts/verify-macos-release.sh"), str(app), "adhoc", "false"]
            verified = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertEqual(verified.stdout, "signing=adhoc\nnotarized=false\n")
            # A changed executable must fail the same publication gate.
            with executable.open("ab") as binary:
                binary.write(b"tampered")
            rejected = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(rejected.returncode, 0)


if __name__ == "__main__":
    unittest.main()
