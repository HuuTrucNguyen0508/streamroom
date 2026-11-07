# Host passphrase and screen audio verification

Verified locally on 2026-11-07 on `feat/passphrase-and-audio`. Implementation commits are `ba2196a` and `24857b8`. Nothing was deployed or pushed. Existing Docker services and `.env` were left alone.

## Checks

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass, lockfile up to date, pnpm 12.17.0 |
| `pnpm typecheck` | Pass, web/Node/Worker including Worker storage tests |
| `pnpm test` | Pass, 8 files and 50 tests, including the original 40 |
| `pnpm build` | Pass, Vite 26 modules plus Node TypeScript build |
| `docker build .` | Pass, final image `db55c50ac84d` |
| `pnpm cf:check` | Pass, Wrangler dry-run, upload 23.53 KiB, gzip 7.23 KiB |
| `bash -n scripts/linux-game-audio.sh` | Pass |
| `git diff --check` | Pass |

Node ran separately on localhost:18981, Wrangler on localhost:18982, with a throwaway host passphrase. Both were stopped, and ignored `.dev.vars` was deleted afterward. No real TURN secrets were used. Browser runs used Playwright headless with fake media.

```sh
E2E_BASE_URL=http://localhost:18981 E2E_HOST_PASSPHRASE=<test-passphrase> pnpm exec playwright test
E2E_BASE_URL=http://localhost:18982 E2E_HOST_PASSPHRASE=<test-passphrase> E2E_CLOUDFLARE=1 pnpm exec playwright test
```

Node output: `3 passed (23.0s)`, `3 skipped`. The skips are two Worker-specific checks and relay-only media. Wrangler output: `5 passed (23.6s)`, `1 skipped`, relay-only media. No failures.

Both transports printed:

```text
Auth: wrong=403, right=204; guest-first join=ok; ICE anonymous=403 valid-invite=200 host=200; unknown peek/WS=404
Screen audio: input=Fake Default Audio Input; receiver bytes 15 -> 30
```

The auth scenario also rejects cross-origin login and unauthenticated explicit room creation. A fresh guest context has no host cookie, joins first, then sees the creator join. Unknown invite navigation shows the expired-room screen. The audio scenario overrides display capture to return video only, checks the warning, selects the fake input, checks increasing receiver screen-audio bytes and the visible stats label, switches to None and back, then checks that all captured share tracks end on Stop sharing.

The existing three-friend scenario passed on both transports, covering voice, simultaneous screen shares, presets, the three-person cap, room locking, stopping a share, music mode and host hand-off. Example real output was `voice Ada->Ben: opus`, `send cap 128 kbps`, and `AV1 2560x1440` inbound screen stats. These are functional media checks, not bandwidth benchmarks. Connections were local host/host UDP and do not prove internet TURN traversal.

The ten new unit tests cover exact passphrase comparison, token signing/tampering/expiry/rotation, cookie flags, Origin and attempt limiting, Node invite creation and idle/active expiry, DO invite persistence across object recreation after an hour, expired HTTP/WS rejection, alarm deletion and early-alarm rescheduling. The hour and 24-hour checks advance a fake clock; they were not wall-clock waits.

## Linux helper

Actual `setup` output:

```text
Created module-null-sink module 536870916
Created module-remap-source module 536870917
Created module-loopback module 536870918
Route ONLY your game to "Streamroom Game" in pavucontrol (Playback) or KDE audio settings.
In Streamroom, choose Audio source > Streamroom Game Audio. Leave browser/voice output on your normal speakers or headphones.
```

Repeating setup printed `Streamroom audio is already configured. Use status, or teardown before setup.`

Status showed the null sink, remapped source and loopback modules, and:

```text
3641 streamroom_game PipeWire float32le 2ch 48000Hz IDLE
3649 streamroom_game_audio PipeWire float32le 2ch 48000Hz SUSPENDED
```

`pactl list sources` confirmed `Description: Streamroom Game Audio`; `pactl list sinks` confirmed `Description: Streamroom Game`. Module properties require nested quoting to preserve spaces on this pipewire-pulse server. The loopback targets the pre-existing default output and does not change it.

Actual teardown output:

```text
Removed module 536870918
Removed module 536870917
Removed module 536870916
Streamroom game audio removed.
```

Post-teardown `pactl list short sinks/sources/modules` contained no Streamroom sink, source or module. Existing iFi output, USB input and EasyEffects devices remained. The helper was exercised more than once, with cleanup after each run.

Real-device headless Chromium, launched without fake-device flags with microphone permission granted, returned:

```json
{"capture":"NotSupportedError: Not supported","devices":[{"kind":"audioinput","label":""},{"kind":"audiooutput","label":""}]}
```

It could not expose the real remapped input in this environment. A live game capture and listening test remains manual. Windows/macOS picker behavior and real external-network TURN were not tested.

## Design and deployment

The DO stores the invite expiry in its own storage and schedules a 24-hour alarm. Membership remains in the shared in-memory call model. The Node transport stores invite expiry in an in-memory registry and prunes expired records. Peek and WebSocket upgrade require an existing unexpired invite. Active calls retain invites; departure refreshes expiry. Empty membership does not delete the invite.

`/api/ice?room=<id>` permits a valid invite, while a valid `sr_host` cookie permits ICE without an invite. There is no TURN allowance available to an unauthenticated base-link visitor when the secret is configured. With no secret, both transports warn and retain open access for development.

The cookie is HMAC-SHA256 signed with the passphrase as key, expires in 90 days, and has Path=/, HttpOnly, SameSite=Lax and Secure. HTTP localhost/loopback omits Secure. Rotation revokes host sessions but does not revoke invite links. The login throttle is best effort per IP per process/isolate, eight attempts per minute, rather than a distributed lockout. Node behind a proxy sees that proxy's address for this limit.

Run these only when deployment is authorized:

```sh
pnpm exec wrangler secret put HOST_PASSPHRASE
pnpm cf:deploy
```

Existing `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets must remain configured. No DO migration is needed. For Node/Docker, set the `HOST_PASSPHRASE` environment variable and rebuild/restart through the normal deployment process. Use a long, private passphrase. Neither deployment was performed here.

Choices to revisit if desired: 90-day browser sessions, the 24-hour idle deadline, first participant owning call controls even if they arrived through a guest invite, per-process login throttling, and allowing any holder of a live invite to mint ICE credentials. These preserve the requested friend-invite model; invite leaks still grant access, and issued TURN credentials retain their existing 12-hour expiry.

Screenshots in `docs/screenshots/` were inspected at desktop and 390px phone widths: `passphrase.png`, `passphrase-mobile.png`, `audio-source-picker.png`, `audio-source-mobile.png`, `no-sound-warning.png`, `no-sound-mobile.png`. All use the existing Bricolage Grotesque, indigo and tungsten styles.
