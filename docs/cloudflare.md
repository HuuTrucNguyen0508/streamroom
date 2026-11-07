# Deploy on Cloudflare

Streamroom runs on a Worker with Static Assets, one SQLite-backed Durable Object per room, and Cloudflare Realtime TURN. A Cloudflare free account supports this setup; a custom domain is optional. The Docker deployment remains available.

## Deploy

Use Node 26 and pnpm 12.17.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
```

Login opens your browser. For a noninteractive deployment, provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the shell instead. Use a token with Workers Scripts Edit and account read access, plus permissions for any custom routes you configure. Never commit credentials.

In the Cloudflare dashboard, open **Realtime > TURN**, create a TURN key, and save its key ID and API token. They are separate from the account deployment token. Configure both Worker secrets:

```sh
pnpm exec wrangler secret put TURN_KEY_ID
pnpm exec wrangler secret put TURN_KEY_API_TOKEN
pnpm cf:deploy
```

Wrangler can prompt to create the `streamroom` Worker when uploading its first secret. The deployment bundles the web app and applies the `v1` migration that creates the SQLite-backed `Room` class. No manual database setup is needed. The URL is `https://streamroom.<account-subdomain>.workers.dev`. Opening it creates an invite link.

`/api/ice` generates fresh credentials for each request using the [Cloudflare TURN API](https://developers.cloudflare.com/realtime/turn/generate-credentials/). Credentials last 43,200 seconds, and responses have `Cache-Control: no-store`. Missing secrets or a provider error produces a logged warning and STUN-only configuration. STUN-only calls may fail between restrictive networks. Do not publish an invite until TURN is configured and tested.

## Local verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm cf:check
pnpm cf:dev --port 8787
```

In another terminal:

```sh
E2E_BASE_URL=http://localhost:8787 pnpm exec playwright test -g "three friends"
E2E_BASE_URL=http://localhost:8787 pnpm exec playwright test -g "relay only"
E2E_CLOUDFLARE=1 E2E_BASE_URL=http://localhost:8787 pnpm exec playwright test e2e/cloudflare.spec.ts
```

The browser tests are headless. The Cloudflare transport checks also verify HTTP routes, origin rejection, room-ID binding, oversized-frame closure, and empty-room cleanup. The relay test explicitly skips if `/api/ice` returns no TURN servers. Without secrets, the three-person test uses local direct peer connections and does not prove Cloudflare TURN. To test real relay media, put `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` in an untracked `.dev.vars`, restart Wrangler, and run the relay test. Repeat both tests against the deployed HTTPS URL before moving friends over. Stop Wrangler with Ctrl-C when finished. The dev script disables Wrangler telemetry and loading Docker's `.env`.

`pnpm cf:check` validates the deployment bundle without logging in, deploying, or requiring secrets. CI runs it after the production build. `pnpm typecheck` includes the Worker; `pnpm cf:typecheck` runs just that check. Unit tests exercise TURN response validation and the shared message handler used by Node and the DO, including capacity, locking, resume replacement, host succession, relay targeting, byte limits, and rate limits.

## Room lifetime and compatibility

Sockets use `accept()`, without the Hibernation API. The existing room model keeps membership, host order, locks, and resume tokens in memory. Hibernation would discard these unless serialized and restored along with connection state. Ordinary sockets keep each active object resident and preserve the current ephemeral behavior. Deployments and runtime restarts reset rooms; empty rooms disappear immediately, with the existing 30-second departed-token grace kept only in memory. SQLite backing enables the Free plan but stores no room data.

HTTP routes remain `/`, `/r/<id>`, `/api/rooms/<id>`, `/api/ice`, and `/healthz`. `/healthz` reports readiness rather than global room counts, since room state is distributed. Signaling uses `/ws?room=<id>` with the same message protocol. The join room must match the routing ID. The Node server accepts that query too; older clients without it cannot connect to the Worker. Both transports share the pure room model, parser, and message dispatch. The Worker checks WebSocket origins against the request host.

The three-person mesh and media presets are unchanged. Every sharer uploads one copy per viewer. Credentials expire after 12 hours; automatic credential renewal is still absent, so longer relay calls need a rejoin. Real OS screen/system audio and external-network relay calls require separate testing. Existing Docker rooms cannot move into Cloudflare; let them finish before changing the hostname.

## Costs and limits

Checked November 7, 2026. Confirm current dashboard pricing before deployment:

- [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/) allows 100,000 requests/day and 10 ms CPU per invocation. Static Asset requests are free; this configuration runs the Worker first to handle the room-creation redirect and security headers.
- [Durable Objects Free](https://developers.cloudflare.com/durable-objects/platform/pricing/) includes 100,000 requests/day and 13,000 GB-seconds/day. Accepted sockets keep objects active and consume duration even when nobody is sending signaling messages. Concurrent rooms share that daily allowance. Exceeding free limits causes requests to fail. SQLite has separate storage and row-operation limits; this app does not write room state.
- [Realtime TURN pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) includes 1,000 GB/month shared with SFU usage, then $0.05/GB of egress. Multiple simultaneous mesh shares multiply relay traffic. TURN billing is separate from Workers/DO usage.

Room links are bearer access. The public ICE endpoint can mint relay credentials for anyone who can reach it. Monitor TURN usage and revoke a key if abused; add account-level rate limiting or access controls if exposing it broadly. The current implementation preserves the app's account-free access model.
