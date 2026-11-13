/**
 * Tests the window a signed media link is pinned to.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - The window is the cache lifetime, aligned to the clock, so every request in it gets one link
 */
import { describe, expect, it } from "vitest";
import { S3ObjectStoreAdapter } from "../../storage/index.js";
import { linkExpirySeconds, linkWindowAt } from "./media-link-window.js";

const HOUR_MS = 3_600_000;

describe("media link window", () => {
  it("is the same for every instant in a window and rolls over at its end", () => {
    const start = 5 * HOUR_MS;
    const first = linkWindowAt(start, 3600);
    expect(first).toEqual({ startMs: start, lengthSeconds: 3600 });
    expect(linkWindowAt(start + HOUR_MS - 1, 3600)).toEqual(first);
    expect(linkWindowAt(start + HOUR_MS, 3600).startMs).toBe(start + HOUR_MS);
    expect(linkExpirySeconds(first)).toBe(7200);
  });

  it("makes an S3 link identical across a window and different in the next", async () => {
    const store = new S3ObjectStoreAdapter({
      bucket: "b",
      region: "auto",
      endpoint: "https://account.r2.example",
      accessKeyId: "key",
      secretAccessKey: "secret",
      signedUrlTtlSeconds: 900,
    });
    const link = async (nowMs: number) => {
      const window = linkWindowAt(nowMs, 3600);
      const signed = await store.getProviderReadLink("uploads/p/d", {
        signedAt: new Date(window.startMs),
        expiresInSeconds: linkExpirySeconds(window),
      });
      if (!signed.ok || signed.value === null) throw new Error("expected a link");
      return signed.value;
    };
    const start = 5 * HOUR_MS;
    expect(await link(start + 10)).toBe(await link(start + HOUR_MS - 10));
    expect(await link(start + HOUR_MS + 10)).not.toBe(await link(start + 10));
  });
});
