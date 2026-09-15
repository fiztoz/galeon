# Benchmarks: Galeon

Reproducible performance harness for the v1.0 trajectory
(product framing in [`DIRECTION.md`](DIRECTION.md) and
[`ROADMAP.md`](ROADMAP.md)).

> **Comparison policy.** Per `ROADMAP.md`, scripted numbers here are for
> regression tracking. **Public** Cyberduck/FileZilla comparisons wait for
> v1.0 — do not publish rival numbers from this harness without rerunning
> every side on the same hardware, same network, same day.

## Reproducibility contract

Every published number must disclose:

| Field | Example |
|---|---|
| Machine | MacBook Pro M3, 18 GB RAM, macOS 15.x |
| Build | `v1.0.0-alpha.4`, release profile, commit SHA |
| MinIO | `quay.io/minio/minio` digest or version, local loop |
| Fixtures | 100 MiB / 1 GiB `/dev/urandom`, 50k × ~30 B keys |
| Date | 2026-09-15 |

Throughput runs against `scripts/dev-minio.sh` (`http://localhost:9000`,
path-style). Rerun `seed` steps after `reset` — MinIO caching otherwise
flatters repeat runs.

## Harness

All scripts live in `scripts/benchmarks/` (`bench.sh` dispatches):

| Script | Measures | Needs |
|---|---|---|
| `bench.sh throughput` | PUT/GET wall time + MiB/s for 100 MiB and 1 GiB, peak MinIO CPU | Docker only |
| `bench.sh seed-50k` | Seeds 50,000 keys (`bench/50k/`) for the listing test | Docker only |
| `bench.sh cold-start` | Launch → RSS-settled latency + binary size | macOS/Linux desktop |
| `bench.sh memory <pid>` | Avg/peak RSS over 30 s | A running app PID |

Results append to timestamped markdown under `src-tauri/target/bench/`
(gitignored, like the e2e `test-downloads/` layout — see
[`TEST_INFRA.md`](TEST_INFRA.md)).

## What each number means (and doesn't)

- **Throughput** is the machine + local-MinIO ceiling, measured with the
  MinIO client — *not* Galeon. Galeon's own transfer timings come from the
  `integrity_e2e` suite (`TEST_INFRA.md`); the gap between the two is app
  overhead (chunking, hashing, queue bookkeeping).
- **Cold-start "settled"** is RSS stability, an approximation — not
  first-paint. It exists to catch regressions (dependency bloat, eager
  init), not to claim a launch-time crown.
- **Memory idle vs 50k**: sample once on an empty bucket, once with the
  seeded `bench/50k/` prefix loaded in the Explorer. The delta is the
  listing cost; absolute idle RSS includes the WebView baseline.

## Runbook

```sh
# 1. Fully automatic baseline (fixtures + PUT/GET table)
scripts/benchmarks/bench.sh throughput

# 2. Seed the listing corpus (takes a few minutes, run once)
scripts/benchmarks/bench.sh seed-50k

# 3. Desktop metrics (quit any running Galeon first)
scripts/benchmarks/bench.sh cold-start
scripts/benchmarks/bench.sh memory <pid-of-running-app>
```

## Results template

Copy into release notes or PRs; fill every row from one session:

```md
| metric | result | notes |
|---|---|---|
| cold-start (release) | ___ ms | binary ___ MB |
| idle RSS avg/peak | ___ / ___ MiB | empty bucket, 30 s |
| 50k-listing RSS avg/peak | ___ / ___ MiB | `bench/50k/` loaded |
| PUT 100 MiB | ___ MiB/s | MinIO baseline |
| GET 100 MiB | ___ MiB/s | MinIO baseline |
| PUT 1 GiB | ___ MiB/s | MinIO baseline |
| GET 1 GiB | ___ MiB/s | MinIO baseline |
```
