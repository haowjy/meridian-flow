/** A picture still in a Work's draft is readable only through that Work, so the request names it. */
import { afterEach, expect, it, vi } from "vitest";

import { getFigureSignedUrl } from "./figures-api";

afterEach(() => vi.unstubAllGlobals());

it("asks for a draft-only picture through the viewing Work, and caches per Work", async () => {
  const fetchMock = vi.fn(async (_url: string) =>
    Response.json({
      assetDocumentId: "a1",
      storageUrl: "s3://a1",
      mimeType: "image/png",
      fileType: "image",
      signedUrl: "https://signed.example/a1",
      signedUrlExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const base = { projectId: "p1", assetDocumentId: "a1" };

  await getFigureSignedUrl({ ...base, workId: "w1" });
  await getFigureSignedUrl({ ...base });

  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls[0]).toContain("/figure/signed-url?workId=w1");
  expect(urls[1]).not.toContain("workId");
});
