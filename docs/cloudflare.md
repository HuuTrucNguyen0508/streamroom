# Cloudflare migration plan

The current app uses one Node process for HTTP and room signaling, in-memory room state, and a self-hosted coturn server. Keep that deployment until the hosted version passes the same three-person and forced-relay tests.

1. Serve the built `dist/web` assets through a Worker with static assets. Route `/`, `/api/rooms/:id`, `/api/ice`, and `/ws` to the signaling code.
2. Move each room into its own Durable Object, keyed by room ID. Reuse the pure room transitions in `src/server/rooms.ts`, but replace Node `ws` and timers with the platform WebSocket and alarm APIs. Preserve capacity, locking, reconnect tokens, host hand-off, rate limits, and empty-room cleanup. Define how hibernation and restarts affect expiration before enabling persistence.
3. Replace coturn credential generation with Cloudflare TURN credentials minted server-side. Keep API secrets in Worker secrets and return only short-lived browser credentials from `/api/ice`. Confirm the provider's current API, limits, pricing, and expiration behavior before implementation. Add credential renewal for calls that outlive a credential.
4. Run the browser suite against a staging hostname over HTTPS. Prove direct and forced-relay voice and video, simultaneous shares, reconnects, full and locked rooms, and cleanup after disconnects. Test real Windows system audio and Linux/macOS tab audio separately from fake media.
5. Compare bandwidth cost with coturn, then switch the invite hostname. Keep the Docker deployment ready for rollback. Existing in-memory rooms do not migrate, so let calls finish before switching.

This changes signaling and relay hosting. It keeps the three-person mesh: every sharer still sends one copy per viewer. An SFU would be a separate architecture change.
