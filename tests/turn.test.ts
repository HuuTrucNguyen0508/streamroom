import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { iceServers, turnCredentials } from "../src/server/turn.ts";

describe("TURN REST credentials", () => {
  it("match coturn's HMAC-SHA1(secret, 'expiry:label') in base64", async () => {
    const { username, credential } = await turnCredentials("s3cret", "streamroom", 1_800_000_000);
    expect(username).toBe("1800000000:streamroom");
    expect(credential).toBe(createHmac("sha1", "s3cret").update(username).digest("base64"));
  });

  it("builds STUN + TURN servers with an expiry ttl seconds from now", async () => {
    const servers = await iceServers({
      stunUrls: ["stun:example.com:3478"],
      turn: { secret: "k", ttlSeconds: 3600, urls: ["turn:example.com:3478?transport=udp"] },
      nowSec: 1000,
      label: "streamroom",
    });
    expect(servers[0]).toEqual({ urls: ["stun:example.com:3478"] });
    expect(servers[1]).toMatchObject({ urls: ["turn:example.com:3478?transport=udp"], username: "4600:streamroom" });
  });

  it("omits TURN when it is not configured", async () => {
    expect(await iceServers({ stunUrls: [], turn: null, nowSec: 0, label: "x" })).toEqual([]);
  });
});
