# Test Infrastructure: Galeon

This document describes the testing philosophy, suite architecture, and requirements for verifying Galeon's backend and E2E transfer integrity.

## Test Philosophy

Galeon uses **opaque-box, requirement-driven testing**. We test the storage and transfer systems at the Tauri command interface boundary (`initiate_download`, `initiate_upload`, `connect_storage`, `get_transfer_queue`, etc.) to simulate frontend user interactions end-to-end. We use mock runtimes and local test services (e.g., MinIO) to run transfers and E2E integration validations.

---

## Test Architecture

*   **Test Runner**: Driven by cargo (`cargo test --lib --manifest-path src-tauri/Cargo.toml`).
*   **CI**: `.github/workflows/ci.yml` starts the loop with `scripts/dev-minio.sh`
    and runs the full suite on Linux; macOS runs the unit tier only. Clippy runs
    with `-D warnings`, so new lints fail the build.
*   **Test Modules**:
    *   **Core Lib Tests**: Unit tests for utility math, path safety guards, and scheduling logic.
    *   **SFTP Native Tests**: Unit and mock session tests for password-based and key-based SFTP.
    *   **FTP Native Tests**: Protocol configurations and session handling.
    *   **Integrity & E2E Tests**: Defined in `src-tauri/src/integrity_e2e.rs`, which runs full transfers against a running local MinIO server to verify size checks, single-file/multipart checksum matches, resume offsets, and bandwidth rules.

### Requirements & Local Services
E2E integration tests require a running MinIO server:
```sh
# Start local MinIO container
./scripts/dev-minio.sh up
```

### Data Layout during Tests
*   Test downloads are saved in `src-tauri/target/test-downloads/`.
*   Test uploads are read from `src-tauri/target/test-uploads/`.

---

## Test Scenario Tiers

Our E2E test suite divides test cases into four tiers of increasing complexity:

### Tier 1: Feature Coverage (Basic Flows)
Verifies that individual features work under ideal, happy-path conditions.
*   Single-file upload/download size & MD5 matching.
*   Multipart upload/download ETag (including `-N` suffix calculation).
*   Transfer queue persistence and basic profile loading.

### Tier 2: Boundary & Corner Cases
Verifies robustness under unusual or edge-case arguments and conditions.
*   Zero-byte file transfers.
*   Exact chunk boundaries (8 MiB, 16 MiB, 24 MiB transitions).
*   Mismatched file sizes or corrupt remote checksums (ensuring they raise proper failures).
*   Path traversal safety checks (blocking `..` patterns).
*   Special characters, emojis, and Unicode representations in object names.

### Tier 3: Cross-Feature Combinations
Tests interactive flows where multiple subsystems interfere.
*   Resuming a download where the remote file has changed or has a corrupt part.
*   Pausing/canceling an active transfer and checking if the remote temp file cleanup is triggered.
*   Concurrent uploads/downloads executing over a single shared protocol session.

### Tier 4: Real-World Scenarios
High-complexity scenarios simulating production workloads.
*   Transferring deep nested directories recursively.
*   Simultaneous execution of ten parallel transfers.
*   Simulated network drops with auto-resume verification.
*   Bandwidth throttling rules matching current time windows.

---

## Running the Suite

To run all 206 tests (142 unit + 64 integrity e2e):

```bash
# Run all tests
cargo test --lib --manifest-path src-tauri/Cargo.toml

# Run E2E tests only
cargo test --lib integrity_e2e

# Run everything EXCEPT the e2e tier (no MinIO needed — this is what the
# macOS CI job runs, since the e2e tier requires a live S3 endpoint)
cargo test --lib -- --skip integrity_e2e

# Run native protocol tests only
cargo test --lib sftp_native::
cargo test --lib ftp_native::
```

## Frontend regression tests

Run `bun run test:frontend` for the Explorer hook suites. They exercise listing races,
filtered selection, folder-size cancellation, native drop cleanup, conflict resolution,
and context-menu dismissal without connecting to storage. Each suite runs in a separate
Bun process so its React/Tauri module mocks cannot affect another suite.

These deterministic hook tests complement `bun run build`; they do not replace the
native Tauri visual pass for themes, dialogs, and split-pane interactions.
