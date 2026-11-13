import { describe, expect, it } from "vitest";
import {
  createInMemoryObjectStore,
  createObjectRelease,
  derivedObjectKeys,
} from "../storage/index.js";
import { prepareBinaryCopy } from "./binary-copy.js";

/** Guards: a file derived from an original (preview, extracted text) is copied and released with it. */
describe("derived files", () => {
  async function stored() {
    const objectStore = createInMemoryObjectStore();
    const key = "uploads/p/doc";
    await objectStore.put(key, new Uint8Array([1]), "application/epub+zip");
    for (const derived of derivedObjectKeys(key))
      await objectStore.put(derived, new Uint8Array([2]), "text/plain");
    return { objectStore, key };
  }

  it("releases every derived file with its original", async () => {
    const { objectStore, key } = await stored();
    await createObjectRelease({ objectStore, onFailure: () => {} }).keys([key]);
    for (const k of [key, ...derivedObjectKeys(key)])
      expect((await objectStore.get(k)).ok, k).toBe(false);
  });

  it("copies every derived file to the copy's key", async () => {
    const { objectStore, key } = await stored();
    const copied = await prepareBinaryCopy({
      objectStore,
      source: {
        uri: "manuscript://book.epub",
        storageUrl: `object://meridian/${key}`,
        mimeType: "application/epub+zip",
        hasPreview: true,
      },
    });
    if (!copied.ok) throw new Error("copy failed");
    expect(copied.value.hasPreview).toBe(true);
    for (const k of derivedObjectKeys(copied.value.key))
      expect((await objectStore.get(k)).ok, k).toBe(true);
  });
});
