import { describe, expect, it } from "vitest";
import { HOST_MAX_AGE, ROOM_IDLE_MS, HostAttempts, RoomInvites, hostCookie, hostToken, isHost, passphraseMatches, sameOrigin } from "../src/shared/host.ts";
import { newRoomId } from "../src/shared/protocol.ts";

describe("host sessions", () => {
  it("compares exact passphrases, including unicode and different lengths", async () => {
    expect(await passphraseMatches("cinéma", "cinéma")).toBe(true);
    expect(await passphraseMatches("cinema", "cinéma")).toBe(false);
    expect(await passphraseMatches("", "long secret")).toBe(false);
  });
  it("signs and verifies cookies, rejects tampering and rotation", async () => {
    const token = await hostToken("secret", 1000);
    expect(await isHost(`other=x; sr_host=${token}`, "secret", 2000)).toBe(true);
    expect(await isHost(`sr_host=${token.slice(0, -2)}00`, "secret", 2000)).toBe(false);
    expect(await isHost(`sr_host=${token}`, "rotated", 2000)).toBe(false);
    expect(await isHost(null, "secret")).toBe(false);
    expect(await isHost(null, "")).toBe(true);
  });
  it("expires at 90 days and rejects future expiry", async () => {
    const token = await hostToken("secret", 1000);
    expect(await isHost(`sr_host=${token}`, "secret", 1000 + HOST_MAX_AGE * 1000)).toBe(false);
    expect(await isHost(`sr_host=${await hostToken("secret", 5000)}`, "secret", 1000)).toBe(false);
  });
  it("uses secure HttpOnly Lax cookies except on HTTP loopback", () => {
    expect(hostCookie("t", new URL("https://example.com"))).toContain("; Secure");
    expect(hostCookie("t", new URL("http://localhost:9999"))).not.toContain("; Secure");
    expect(hostCookie("t", new URL("http://example.com"))).toContain("; Secure");
    expect(hostCookie("t", new URL("https://example.com"))).toContain("HttpOnly; SameSite=Lax");
  });
  it("requires exact origin and throttles attempts with expiry", () => {
    const url = new URL("https://example.com");
    expect(sameOrigin("https://example.com", url)).toBe(true);
    expect(sameOrigin(null, url)).toBe(false);
    expect(sameOrigin("http://example.com", url)).toBe(false);
    const attempts = new HostAttempts();
    for (let n = 0; n < 8; n++) expect(attempts.allow("ip", 0)).toBe(true);
    expect(attempts.allow("ip", 0)).toBe(false);
    expect(attempts.allow("ip", 60000)).toBe(true);
  });
});
describe("invite lifetime", () => {
  it("requires creation and survives an hour without members", () => {
    const invites = new RoomInvites(), id = newRoomId();
    expect(invites.exists(id, false, 0)).toBe(false);
    invites.create(id, 3, 0);
    expect(invites.exists(id, false, 3600000)).toBe(true);
    expect(invites.exists(id, false, ROOM_IDLE_MS)).toBe(false);
  });
  it("keeps active rooms and refreshes the idle deadline on departure", () => {
    const invites = new RoomInvites(), id = newRoomId();
    invites.create(id, 3, 0);
    expect(invites.exists(id, true, ROOM_IDLE_MS + 1)).toBe(true);
    invites.touch(id, ROOM_IDLE_MS + 1);
    expect(invites.exists(id, false, ROOM_IDLE_MS * 2)).toBe(true);
    expect(invites.exists(id, false, ROOM_IDLE_MS * 2 + 1)).toBe(false);
  });
  it("remembers the seat count chosen at creation, through refreshes", () => {
    const invites = new RoomInvites(), id = newRoomId();
    expect(invites.seats(id)).toBeUndefined();
    invites.create(id, 7, 0);
    invites.touch(id, 1000);
    expect(invites.seats(id)).toBe(7);
  });
});
