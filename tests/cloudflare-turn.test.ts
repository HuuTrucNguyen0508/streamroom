import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareIce } from "../src/cloudflare/turn.ts";

const secrets = { TURN_KEY_ID: "key", TURN_KEY_API_TOKEN: "secret" };
const relay = { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "user", credential: "password" };

afterEach(() => vi.restoreAllMocks());

describe("Cloudflare TURN", () => {
  it("warns and returns STUN only without either secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>();
    for (const env of [{}, { TURN_KEY_ID: "key" }, { TURN_KEY_API_TOKEN: "secret" }]) {
      expect(await cloudflareIce(env, fetcher)).toEqual({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }], ttlSeconds: null });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("requests fresh 12-hour credentials per client and maps the documented response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ iceServers: [relay] }, { status: 201 }));
    const result = await cloudflareIce(secrets, fetcher);
    expect(result).toEqual({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, relay], ttlSeconds: 43200 });
    expect(fetcher).toHaveBeenCalledWith("https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers", expect.objectContaining({
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" }, body: '{"ttl":43200}',
    }));
    await cloudflareIce(secrets, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("normalizes the single-server shape and string URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ iceServers: { ...relay, urls: relay.urls[0] } }));
    expect((await cloudflareIce(secrets, fetcher)).iceServers[1]).toEqual({ ...relay, urls: [relay.urls[0]] });
  });

  it.each([{}, { iceServers: [{ urls: ["https://bad.example"] }] }, { iceServers: [{ urls: ["turn:relay"] }] }])("falls back on malformed provider data %j", async (body) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    expect((await cloudflareIce(secrets, fetcher)).ttlSeconds).toBeNull();
  });

  it("falls back on provider failure without logging credentials", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret"));
    expect((await cloudflareIce(secrets, fetcher)).ttlSeconds).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });
});
