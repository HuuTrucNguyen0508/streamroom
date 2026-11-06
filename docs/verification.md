# Local verification, 2026-11-06

Verified on `feat/initial-app` with Node v26.13.0 and pnpm 12.17.0. Docker Compose serves the app on localhost:8088 through the ignored local `.env`. Default configuration remains port 8080.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass, lockfile unchanged |
| `pnpm typecheck` | Pass |
| `pnpm test` | Pass, 4 files and 28 tests |
| `pnpm build` | Pass, 26 Vite modules plus server TypeScript output |
| `docker build .` | Pass, image `5cdda31d6bbb` |
| `docker compose up -d --build` | Pass, app healthy and coturn running |
| `curl -fsS http://localhost:8088/healthz` | `{"ok":true,"rooms":0,"sockets":0}` |
| Two requests to `/api/ice` | STUN plus UDP/TCP TURN URLs, credentials present, TTL 43200 seconds, distinct usernames |
| `E2E_BASE_URL=http://localhost:8088 pnpm test:e2e:screenshots` | 2 passed, 31.0 seconds |

The suite contains two tests. The previous report of three tests did not match the interrupted tree. Each run covers three-person voice, simultaneous screen sharing, bitrate caps, capacity, locking enforced through raw WebSocket, host hand-off, late joining during a share, music mode, and a separate forced-relay call through coturn.

Three consecutive runs of `E2E_BASE_URL=http://localhost:8088 pnpm test:e2e`, with no retries:

| Run | Result | Duration |
| --- | --- | --- |
| 1 | 2 passed | 25.9 seconds |
| 2 | 2 passed | 25.9 seconds |
| 3 | 2 passed | 25.9 seconds |

Captured output remains locally in ignored `e2e-run-1.log`, `e2e-run-2.log`, and `e2e-run-3.log`.

Observed media in those three runs:

- AV1 at 2560×1440, 19–20 fps in early samples and 20 fps at the later send samples.
- Ada's send samples were 226–230 kbps per viewer, with an asserted 8000 kbps cap. Ben's asserted cap was 12000 kbps per viewer.
- Opus at 48000 Hz, two channels, `stereo=1`, `sprop-stereo=1`, and `maxaveragebitrate=128000`. Audio send cap was 128 kbps.
- Direct candidate pairs were host/host over UDP. Forced-relay candidate pairs were relay/relay over UDP on both participants, with growing voice bytes and decoded video frames.

Chromium's fake screen produces a simple moving pattern at about 20 fps. Its low encoded bitrate does not demonstrate capacity for real 1440p/60 or 4K content. The relay test logs a single video sample with an unknown bitrate because there is no earlier sample for that stream. It proves media flow and candidate selection, not relay throughput.

Generated and opened all three screenshots for visual inspection:

- `screenshots/join.png`, 1440×900.
- `screenshots/call.png`, 1440×900, live stage and stats overlay.
- `screenshots/call-mobile.png`, 390×844, live stage and three seats.

Desktop seats use a face beside a separate info column. Phone seats stack the info beneath each face so all three fit in one row. Names align without reserving fake volume controls for the local participant.

CI deliberately omits e2e until host-network TURN is verified on a GitHub Ubuntu runner. Its frozen install, typecheck, unit test, production build, and Docker build commands all passed locally. The workflow itself has not run on GitHub. Node 26 matches the container and satisfies the package's Node >=24 engine. pnpm/action-setup v6 documents pnpm 12 support, and the pinned 12.17.0 release exists.

Public Caddy TLS issuance, remote NAT traversal, real OS audio capture, 4K capture, and long-running credential expiration were not tested. coturn requires Linux host networking and direct reachability. The Cloudflare document is a migration plan, not an implementation.

The Docker stack was stopped with `docker compose down` after verification. No push, remote repository, PR, or external deployment was created.
