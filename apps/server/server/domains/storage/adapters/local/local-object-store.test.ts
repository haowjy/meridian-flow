import { describe, expect, it } from "vitest";
import { LocalObjectStoreAdapter } from "./local-object-store.js";

describe("LocalObjectStoreAdapter", () => {
  it("reports filesystem failures instead of treating a non-directory root as an empty store", async () => {
    const store = new LocalObjectStoreAdapter({
      rootDir: "/dev/null",
      signedUrlBasePath: "/objects",
      signingSecret: "test-secret",
      signedUrlTtlSeconds: 60,
    });

    await expect(store.get("present")).resolves.toMatchObject({
      ok: false,
      error: { code: "io_error" },
    });
    await expect(store.getSignedUrl("present")).resolves.toMatchObject({
      ok: false,
      error: { code: "io_error" },
    });
    await expect(store.list("")).resolves.toMatchObject({
      ok: false,
      error: { code: "io_error" },
    });
  });
});
