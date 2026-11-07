# Streamroom

A temporary room for screen sharing and voice with up to three people. Open a link, choose a name, and invite two friends. Multiple people can share at once. Rooms live in memory and disappear when empty or when their server restarts. There are no accounts or recordings.

## Quick start

### Cloudflare

Host the app without leaving your PC running. Use a free Cloudflare account, Workers Static Assets, Durable Objects, and Realtime TURN:

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler secret put TURN_KEY_ID
pnpm exec wrangler secret put TURN_KEY_API_TOKEN
pnpm cf:deploy
```

Create the TURN key and API token in the Cloudflare dashboard under **Realtime > TURN**. Open `https://streamroom.<account-subdomain>.workers.dev`. See the [deploy guide](docs/cloudflare.md) for noninteractive authentication, local testing, costs, and limits.

### Docker

Use Docker Compose on Linux. coturn uses host networking.

```sh
cp .env.example .env
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

Use a desktop Chromium browser for screen capture. Chrome on Windows can share system audio. On Linux and macOS, Chrome shares tab audio rather than whole-system audio. Select a browser tab and enable its audio option in the picker. Available sources depend on the browser and operating system. Mobile browsers can join voice and view shares, but screen capture support varies.

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
