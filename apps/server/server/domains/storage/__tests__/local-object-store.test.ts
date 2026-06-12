import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalObjectStoreAdapter } from "../adapters/local/local-object-store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meridian-object-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("LocalObjectStoreAdapter", () => {
  it("stores bytes under a stable object URL and reads them through a signed token", async () => {
    const store = new LocalObjectStoreAdapter({
      rootDir: await tempRoot(),
      signedUrlBasePath: "/api/object-store/local",
      signingSecret: "secret",
      signedUrlTtlSeconds: 60,
      now: () => new Date("2026-06-04T12:00:00.000Z"),
    });

    const put = await store.put(
      "figures/workbench/document/a.png",
      Buffer.from("image-bytes"),
      "image/png",
    );
    expect(put).toEqual({
      ok: true,
      value: { storageUrl: "object://meridian/figures/workbench/document/a.png" },
    });

    const signed = await store.getSignedUrl("figures/workbench/document/a.png");
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;

    const token = signed.value.split("/").pop();
    expect(token).toBeTruthy();
    const read = await store.readSignedToken(token ?? "");
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const chunks: Buffer[] = [];
    for await (const chunk of read.value.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("image-bytes");
    expect(read.value.mimeType).toBe("image/png");
  });

  it("reads stored bytes through get and lists keys by prefix", async () => {
    const store = new LocalObjectStoreAdapter({
      rootDir: await tempRoot(),
      signedUrlBasePath: "/api/object-store/local",
      signingSecret: "secret",
      signedUrlTtlSeconds: 60,
    });

    await store.put("uploads/wb/thread/a.png", Buffer.from("alpha"), "image/png");
    await store.put("uploads/wb/thread/b.png", Buffer.from("beta"), "image/png");
    await store.put("figures/other/c.png", Buffer.from("gamma"), "image/png");

    const got = await store.get("uploads/wb/thread/a.png");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(Buffer.from(got.value.bytes).toString("utf8")).toBe("alpha");
    expect(got.value.mimeType).toBe("image/png");

    const listed = await store.list("uploads/wb/thread/");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.keys.map((entry) => entry.key).sort()).toEqual([
      "uploads/wb/thread/a.png",
      "uploads/wb/thread/b.png",
    ]);
  });

  it("rejects keys that escape the storage root", async () => {
    const store = new LocalObjectStoreAdapter({
      rootDir: await tempRoot(),
      signedUrlBasePath: "/api/object-store/local",
      signingSecret: "secret",
      signedUrlTtlSeconds: 60,
    });

    const put = await store.put("../escape.png", Buffer.from("x"), "image/png");
    expect(put.ok).toBe(false);
    if (!put.ok) expect(put.error.code).toBe("invalid_key");
  });

  it("expires signed tokens", async () => {
    let now = new Date("2026-06-04T12:00:00.000Z");
    const store = new LocalObjectStoreAdapter({
      rootDir: await tempRoot(),
      signedUrlBasePath: "/api/object-store/local",
      signingSecret: "secret",
      signedUrlTtlSeconds: 1,
      now: () => now,
    });

    await store.put("figures/workbench/document/a.png", Buffer.from("image-bytes"), "image/png");
    const signed = await store.getSignedUrl("figures/workbench/document/a.png");
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;

    now = new Date("2026-06-04T12:00:02.000Z");
    const token = signed.value.split("/").pop() ?? "";
    const read = await store.readSignedToken(token);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("not_found");
  });
});
