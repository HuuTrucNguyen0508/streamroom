# Streamroom

A temporary room for screen sharing and voice with up to three people. Open a link, choose a name, and invite two friends. Multiple people can share at once. Invite links expire after 24 hours without a call. Cloudflare stores invites durably; Node keeps them in memory until restart. There are no accounts or recordings.

## Quick start

### Cloudflare

Host the app without leaving your PC running. Use a free Cloudflare account, Workers Static Assets, Durable Objects, and Realtime TURN:

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler secret put HOST_PASSPHRASE
pnpm exec wrangler secret put TURN_KEY_ID
pnpm exec wrangler secret put TURN_KEY_API_TOKEN
pnpm cf:deploy
```

Create the TURN key and API token in the Cloudflare dashboard under **Realtime > TURN**. Open `https://streamroom.<account-subdomain>.workers.dev`. See the [deploy guide](docs/cloudflare.md) for noninteractive authentication, local testing, costs, and limits.

### Docker

Use Docker Compose on Linux. coturn uses host networking.

```sh
cp .env.example .env
# Set HOST_PASSPHRASE to a long private passphrase.
# Set TURN_SECRET in .env to the output of: openssl rand -base64 32
docker compose up -d --build
```

Open http://localhost:8080. Copy the room's invite link to invite friends. If that port is busy, set `PORT` in `.env`, then use that port in the URL. This machine uses 8088 locally. Stop the stack with `docker compose down`.

## Invite friends over HTTPS

Microphone and screen capture require HTTPS outside localhost. A room link grants access, so share it privately. The host can lock the room and leaves host control to the next participant when leaving.

For a public host, point a domain's DNS at the server and set `DOMAIN` in `.env`. Set `TURN_HOST` to a DNS hostname that reaches coturn directly, without an HTTP proxy. Open TCP 80 and 443 for Caddy, TCP and UDP 3478 for TURN, and UDP 49160–49200 for relay media. Forward those ports if the host sits behind a router, and set `TURN_EXTERNAL_IP` to its public IP. Then run:

```sh
docker compose --profile public up -d --build
```

Open `https://your-domain` and share the room link. Caddy handles HTTPS and WebSocket forwarding. To stop this profile, use `docker compose --profile public down`.

For a private setup, put all friends on the same Tailscale network and use Tailscale Serve to expose the app with HTTPS. Set `TURN_HOST` to a hostname or IP reachable by those friends. Tailscale Serve carries the web connection, not TURN's UDP traffic. Prefer direct peer connections on that network. The bundled coturn policy blocks private peer addresses except its configured relay IP, so relay-only calls across Tailscale may require a deliberately scoped coturn policy change.

## Quality and bandwidth

Video prefers AV1, then VP9, with browser codec fallback. These presets request upper bounds. Capture hardware, browser support, CPU, and the network determine the result.

| Preset | Requested maximum | Video cap per viewer | Upload with one viewer | Upload with two viewers |
| --- | --- | --- | --- | --- |
| Text and code | 2560×1440 at 30 fps | 8 Mbps | 8 Mbps | 16 Mbps |
| Motion and games | 2560×1440 at 60 fps | 12 Mbps | 12 Mbps | 24 Mbps |
| Max (4K) | 3840×2160 at 60 fps | 25 Mbps | 25 Mbps | 50 Mbps |

Each sharer uploads a separate copy to each viewer, even through TURN. Allow extra bandwidth for transport overhead and up to 128 kbps per audio track per viewer. Multiple simultaneous shares add their own upload costs. The Stats panel shows actual codec, resolution, frame rate, bitrate, and connection route.

Voice uses Opus. Music mode requests stereo and disables echo cancellation and noise suppression. Wear headphones in that mode.

## Browser limits

Use a desktop Chromium browser for screen capture. Chrome on Windows can share system audio. On Linux, Chrome can capture tab audio but cannot capture whole-system audio through the screen picker. On macOS with Chrome 141 or later, enable system audio when offered. Select a browser tab and enable its audio option in the picker. Available sources depend on the browser and operating system. Mobile browsers can join voice and view shares, but screen capture support varies.

Media travels between peers, directly or through TURN. The signaling server forwards negotiation messages. Links are bearer access, and the app does not provide identity verification. TURN credentials expire after 12 hours by default; long-running connections have no automatic credential renewal.

## Develop and test

Use Node 26 and pnpm 12.17.0, pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

For local development, run `pnpm dev:server` and `pnpm dev` in separate terminals. Configure TURN environment variables for relay calls.

Run headless end-to-end tests against the Docker stack:

```sh
pnpm exec playwright install chromium
E2E_BASE_URL=http://localhost:8080 pnpm test:e2e
E2E_BASE_URL=http://localhost:8080 pnpm test:e2e:screenshots
```

Use 8088 here if using this machine's `.env`. Tests use fake media, real peer connections, and real coturn, including a forced relay call. Screenshots go to `docs/screenshots/`. They do not open a visible browser.

CI runs the frozen install, Node/web/Worker typechecks, unit tests, production build, Wrangler deployment dry-run, and Docker build. End-to-end tests stay local because the host-network TURN path has not been validated on GitHub's Ubuntu runners. Configure the `check` job as a required branch-protection check when publishing the repository.

For local Cloudflare development, run `pnpm cf:dev --port 8787`. Run the same headless suite against that port. The relay test skips explicitly without TURN credentials. See the [Cloudflare deploy guide](docs/cloudflare.md).

The [pnpm 12.17.0 release](https://github.com/pnpm/pnpm/releases/tag/v12.17.0) exists, and [pnpm/action-setup v6 supports pnpm 12](https://github.com/pnpm/action-setup). CI uses that exact pnpm version and Node 26, matching the Docker image.

## Host access and invite lifetime

Set `HOST_PASSPHRASE` as a Worker secret or a Node environment variable. Docker Compose passes it from `.env`. Use a long, private passphrase. With no passphrase, the app logs a warning and allows open room creation and ICE access for development.

The base link asks for the passphrase, then creates an invite on the server. Friends open that invite without a passphrase, even before its creator joins. The first person to join still controls the call, with the existing hand-off order. Each idle invite lasts 24 hours; an active call keeps it alive and departure refreshes the deadline. Unknown and expired invites cannot join or mint TURN credentials.

The `sr_host` cookie lasts 90 days and uses an HMAC-SHA256 signature keyed by the passphrase, HttpOnly, Secure and SameSite=Lax. HTTP localhost omits Secure. Changing the passphrase invalidates existing host sessions. Host login and explicit room creation require a same-origin POST. Login allows eight attempts per IP per minute, best effort per Node process or Worker isolate. An authenticated host can also start another room by opening `/`.

Guests request ICE with `/api/ice?room=<invite-id>`; a host cookie also authorizes `/api/ice`. Invite links remain bearer access, so anyone with a live invite can request credentials. This protects against base-link visitors, not invite leaks. TURN credentials retain their existing 12-hour lifetime.

## Sharing game audio on Linux

Chrome on Linux doesn't capture a game's system audio through `getDisplayMedia`. During a share, use **Audio source** to choose a normal audio input, Browser audio, or None. Inputs send stereo with echo cancellation, noise suppression and automatic gain control off. Switching sources keeps the same screen-audio path, volume control and stats label. The choice is remembered in this browser and capture stops with the share. The app warns when Browser audio has no captured audio track.

To make a game-only input with PulseAudio or PipeWire's PulseAudio compatibility server, install `pactl` and run:

```sh
scripts/linux-game-audio.sh setup
scripts/linux-game-audio.sh status
```

In pavucontrol's Playback tab or KDE audio settings, route **only the game** to **Streamroom Game**. In Streamroom's Audio source, select **Streamroom Game Audio**. The script loops the game back to the default output selected during setup, so you still hear it. Leave your browser and friends' voices on the normal output. Routing the browser into this game sink would capture friends' voices and cause an echo. Headphones remain the best choice.

When finished:

```sh
scripts/linux-game-audio.sh teardown
```

Setup is idempotent and doesn't change the default sink. Teardown checks recorded module IDs and arguments before removing only the modules it created. State is stored under `$XDG_RUNTIME_DIR/streamroom-game-audio` with a per-user fallback in `/tmp`. After an audio-server restart, run teardown before setup again.

On Windows, share **Entire screen** and tick **Also share system audio**. For a browser tab on any supported OS, tick **Also share tab audio**. On macOS Chrome 141 or later, tick system audio when available. A missing or disconnected input produces an error so you can choose another source.

For authenticated headless testing on an isolated Node or Wrangler port, set the same throwaway `HOST_PASSPHRASE` on the server and `E2E_HOST_PASSPHRASE` on Playwright. `e2e/host-audio.spec.ts` covers login, invite-first joining, HTTP/WS/ICE rejection and screen-audio switching. Existing three-friend and Cloudflare tests also accept that test environment variable. Keep `.dev.vars` ignored and remove it after local testing.
