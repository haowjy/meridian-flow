import { describe, expect, it } from "vitest";
import { createInMemoryObjectStore } from "../index.js";

describe("InMemoryObjectStoreAdapter", () => {
  it("round-trips bytes through get and lists by prefix", async () => {
    const store = createInMemoryObjectStore();
    const payload = Uint8Array.from([0, 255, 4, 20]);

    await store.put("uploads/dataset/labels.nii.gz", payload, "application/gzip");
    await store.put("uploads/dataset/qc/plot.png", Uint8Array.from([1]), "image/png");
    await store.put("figures/other.png", Uint8Array.from([2]), "image/png");

    const got = await store.get("uploads/dataset/labels.nii.gz");
    expect(got).toEqual({
      ok: true,
      value: { bytes: payload, mimeType: "application/gzip" },
    });

    const listed = await store.list("uploads/dataset/");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.keys.map((entry) => entry.key).sort()).toEqual([
      "uploads/dataset/labels.nii.gz",
      "uploads/dataset/qc/plot.png",
    ]);
  });
});
