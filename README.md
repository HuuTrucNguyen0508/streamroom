# Streamroom

A temporary room for screen sharing and voice. The host picks the number of seats, from 2 to 10 (3 by default), when starting a room; open the link, choose a name, and invite your friends. Calls are peer-to-peer, so whoever shares their screen uploads one copy per viewer: big rooms need fast upload. Multiple people can share at once, chat, and send each other files. Invite links expire after 1 hour without a call. Cloudflare stores invites durably; Bun keeps them in memory until restart. There are no accounts or recordings.

## Quick start

### On your own computer

To try Streamroom or call friends on your Tailscale network, run it with Bun. You don't need Docker or a domain:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open http://localhost:8080. The [local guide](docs/local.md) covers the host passphrase, calling friends over HTTPS, and the limits of this setup.

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

Open http://localhost:8080. Copy the room's invite link to invite friends. If that port is busy, set `PORT` in `.env`, then use that port in the URL. Stop the stack with `docker compose down`.

## Invite friends over HTTPS

Microphone and screen capture require HTTPS outside localhost. A room link grants access, so share it privately. The host can lock the room and leaves host control to the next participant when leaving.

To host it publicly on a Linux server with Docker:

1. Point a DNS A record for your domain at the server's public IPv4 address.
2. Run the setup script from the repository root and enter the domain when asked:

   ```sh
   scripts/setup.sh
   ```

3. Open or forward the ports it prints: TCP 80 and 443 for Caddy, TCP and UDP 3478 for TURN, UDP 443 for HTTP/3 (optional), and UDP 49160–49200 for relay media.

The script checks Docker, works out whether the server has its own public IP or sits behind a router, and writes `.env`. It generates `TURN_SECRET` and `HOST_PASSPHRASE`, sets `DOMAIN`, binds the app to `127.0.0.1` behind Caddy, and sets `TURN_EXTERNAL_IP` when the server is behind NAT. It also fills an empty `TURN_RELAY_IP` with the local address receiving traffic. Then it starts the `public` profile and checks HTTPS through Caddy. It prints the URL and the host passphrase. Open `https://your-domain`, enter the passphrase, and share the room link. Running it again keeps existing secrets and backs up `.env` to `.env.bak.<timestamp>` before changing it. It doesn't install Docker. It asks before it changes ufw or firewalld rules. Behind a router, it prints the port forwards to this machine's LAN address. If your ISP uses CGNAT, port forwarding cannot work; use a VPS. `--domain`, `--yes` and `--no-start` allow noninteractive runs, and `--help` lists every option.

```sh
scripts/setup.sh status   # network, ports, containers and health checks; changes nothing
scripts/setup.sh update   # git pull --ff-only, then rebuild and restart
scripts/setup.sh stop     # stop the stack; volumes and certificates stay
```

To set it up by hand instead, copy `.env.example` to `.env`, then set `DOMAIN`, `TURN_SECRET` (`openssl rand -base64 32`), `HOST_PASSPHRASE` and `APP_BIND=127.0.0.1`. Set `TURN_EXTERNAL_IP` to the public IP when the host sits behind NAT. `TURN_HOST` can stay empty, because browsers then use the page's hostname, which is `DOMAIN`. Run `docker compose --profile public up -d --build`, and stop it with `docker compose --profile public down`. Caddy handles HTTPS and WebSocket forwarding.

For a private setup, put all friends on the same Tailscale network and use Tailscale Serve to expose the app with HTTPS. Set `TURN_HOST` to a hostname or IP reachable by those friends. Tailscale Serve carries the web connection, not TURN's UDP traffic. Prefer direct peer connections on that network. The bundled coturn policy blocks private peer addresses except its configured relay IP, so relay-only calls across Tailscale may require a deliberately scoped coturn policy change.

## Quality and bandwidth

Video prefers AV1, then VP9, with browser codec fallback. These presets request upper bounds. Capture hardware, browser support, CPU, and the network determine the result.

| Preset | Requested maximum | Video cap per viewer | Upload with one viewer | Upload with two viewers |
| --- | --- | --- | --- | --- |
| Text and code | 2560×1440 at 30 fps | 8 Mbps | 8 Mbps | 16 Mbps |
| Motion and games | 2560×1440 at 60 fps | 12 Mbps | 12 Mbps | 24 Mbps |
| Max (4K) | 3840×2160 at 60 fps | 25 Mbps | 25 Mbps | 50 Mbps |

Each sharer uploads a separate copy to each viewer, even through TURN. Allow extra bandwidth for transport overhead and up to 128 kbps per audio track per viewer. Multiple simultaneous shares add their own upload costs. The Stats panel shows actual codec, resolution, frame rate, bitrate, and connection route.

Voice uses Opus with the browser's echo cancellation and noise suppression. Screen-share audio is sent in stereo with no voice processing.

## Chat and files

Open **Chat** in the call controls to message the room. Messages travel over the signaling connection. People who join later see the recent history: the newest 100 messages, up to 256 KiB. Each person can send 10 messages in a burst, then one per second. History lives only in server memory. It disappears when the last person leaves, even if they reconnect a moment later, and when the server or Durable Object restarts.

Attach files with the paperclip, or drop them anywhere on the call. A file never touches the server. The chat shows its name and size, and each friend who chooses **Download** receives it directly from the sender's browser over the call's peer connection. The receiver checks the whole file against the sender's SHA-256 before offering **Save**. If the receiver's connection to the room drops, the download pauses and continues from where it stopped once the call reconnects.

Limits:

- Each file can be up to 1 GiB. A receiver can hold up to 2 GiB of downloads at once, counting files still arriving and finished files not yet dismissed.
- The sender must stay in the room with the tab open until everyone has the file. If the sender leaves or reconnects, their earlier files can no longer be downloaded; share them again.
- Received files stay in the tab's memory until saved and dismissed, or until the tab leaves the room.

## Point and draw

Press the pen in a shared screen's caption to point and draw on it. Everyone watching that screen sees your pointer with your name, and your strokes in your color. Hold the mouse button, or touch and drag, to draw. A stroke stays for a few seconds after you let go, then fades. The eraser clears your own strokes, and **Esc** or the pen puts the pen down. Clicks pass through to the page again once the pen is down.

Pointers and strokes travel directly between browsers on a `draw` data channel, as fractions of the shared picture, so they line up on any screen size. They are never stored. The person sharing sees the marks on their own preview in Streamroom, not on their real desktop: drawing over the desktop itself would need a small app on the sharer's computer.

## Browser limits

Use a desktop Chromium browser for screen capture. Chrome on Windows can share system audio. On Linux, Chrome can capture tab audio but cannot capture whole-system audio through the screen picker. On macOS with Chrome 141 or later, enable system audio when offered. Select a browser tab and enable its audio option in the picker. Available sources depend on the browser and operating system. Mobile browsers can join voice and view shares, but screen capture support varies.

Media travels between peers, directly or through TURN. The signaling server forwards negotiation messages. Links are bearer access, and the app does not provide identity verification. TURN credentials expire after 12 hours by default; long-running connections have no automatic credential renewal.

## Develop and test

Use Bun 1.4.4 for the local server, Node 26 for Vite/Vitest/Wrangler, and pnpm 12.17.0 for all package management. Run `pnpm install`, never `bun install`. Docker uses `oven/bun:1.4.4-slim` as a non-root runtime and Node only to build the web assets.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

For local development, run `pnpm dev:server` and `pnpm dev` in separate terminals. The server serves `dist/web` by default, so run `pnpm build` first for standalone use, then `pnpm start`. Override `PUBLIC_DIR` to serve another directory. Configure TURN environment variables for relay calls. Bun loads `.env` from the current folder automatically, so `pnpm start` picks up your TURN settings; it only relays if coturn is also running (`docker compose up -d coturn`).

Run headless end-to-end tests against the Docker stack:

```sh
pnpm exec playwright install chromium
E2E_BASE_URL=http://localhost:8080 pnpm test:e2e
E2E_BASE_URL=http://localhost:8080 pnpm test:e2e:screenshots
```

If you changed `PORT`, use that port in `E2E_BASE_URL`. Tests use fake media, real peer connections, and real coturn, including a forced relay call. Screenshots go to `docs/screenshots/`. They do not open a visible browser.

CI runs the frozen install, Bun/web/Worker typechecks, unit tests, production build, Wrangler deployment dry-run, and Docker build. End-to-end tests stay local because the host-network TURN path has not been validated on GitHub's Ubuntu runners. Configure the `check` job as a required branch-protection check when publishing the repository.

For local Cloudflare development, run `pnpm cf:dev --port 8787`. Run the same headless suite against that port. The relay test skips explicitly without TURN credentials. See the [Cloudflare deploy guide](docs/cloudflare.md).

The [pnpm 12.17.0 release](https://github.com/pnpm/pnpm/releases/tag/v12.17.0) exists, and [pnpm/action-setup v6 supports pnpm 12](https://github.com/pnpm/action-setup). CI uses that exact pnpm version and Node 26, matching the Docker build stage.

## Host access and invite lifetime

Set `HOST_PASSPHRASE` as a Worker secret or a Bun environment variable. Docker Compose passes it from `.env`. Use a long, private passphrase. With no passphrase, the app logs a warning and allows open room creation and ICE access for development.

The base link asks for the passphrase, then creates an invite on the server. Friends open that invite without a passphrase, even before its creator joins. The first person to join still controls the call, with the existing hand-off order. Each idle invite lasts 1 hour; an active call keeps it alive and departure refreshes the deadline. Unknown and expired invites cannot join or mint TURN credentials.

The `sr_host` cookie lasts 90 days and uses an HMAC-SHA256 signature keyed by the passphrase, HttpOnly, Secure and SameSite=Lax. HTTP localhost omits Secure. Changing the passphrase invalidates existing host sessions. Host login and explicit room creation require a same-origin POST. Login allows eight attempts per IP per minute, best effort per Bun process or Worker isolate. An authenticated host can also start another room by opening `/`.

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

For authenticated headless testing on an isolated Bun or Wrangler port, set the same throwaway `HOST_PASSPHRASE` on the server and `E2E_HOST_PASSPHRASE` on Playwright. `e2e/host-audio.spec.ts` covers login, the seat picker and room-size limits, invite-first joining, HTTP/WS/ICE rejection and screen-audio switching. Existing three-friend and Cloudflare tests also accept that test environment variable. Keep `.dev.vars` ignored and remove it after local testing.

## License

MIT. See [LICENSE](LICENSE).
