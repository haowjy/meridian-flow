import { afterEach, describe, expect, it, vi } from "vitest";

import { getFigureSignedUrl } from "./figures-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("figure signed URL requests", () => {
  it.each([false, true])("deduplicates concurrent requests (skipCache=%s)", async (skipCache) => {
    const assetDocumentId = `asset-${skipCache ? "refresh" : "initial"}`;
    const response = {
      assetDocumentId,
      storageUrl: `storage://${assetDocumentId}`,
      mimeType: "image/png",
      fileType: "image" as const,
      signedUrl: `https://signed.example/${assetDocumentId}`,
      signedUrlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const input = { projectId: "project-1", assetDocumentId, skipCache };
    const [first, second] = await Promise.all([
      getFigureSignedUrl(input),
      getFigureSignedUrl(input),
    ]);

    expect(first).toEqual(response);
    expect(second).toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears failed requests so a later manual retry can proceed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("failed", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            assetDocumentId: "asset-retry",
            storageUrl: "storage://asset-retry",
            mimeType: "image/png",
            fileType: "image",
            signedUrl: "https://signed.example/asset-retry",
            signedUrlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      projectId: "project-1",
      assetDocumentId: "asset-retry",
      skipCache: true,
    };

    await expect(getFigureSignedUrl(input)).rejects.toThrow("failed");
    await expect(getFigureSignedUrl(input)).resolves.toMatchObject({
      assetDocumentId: "asset-retry",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
