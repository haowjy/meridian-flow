/** Thin admission lookup/retirement adapters preserve the F5 result union. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupUserMessageAdmission, retireUserMessageAdmission } from "./threads-api";

afterEach(() => vi.unstubAllGlobals());
describe("thread admission adapters", () => {
  it("uses the canonical encoded identity path for GET and JSON DELETE", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ kind: "not-seen", submissionId: "sub/1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ kind: "retired", submissionId: "sub/1", code: "retired" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      lookupUserMessageAdmission({ threadId: "thread-1", submissionId: "sub/1" }),
    ).resolves.toEqual({ kind: "not-seen", submissionId: "sub/1" });
    await expect(
      retireUserMessageAdmission({ threadId: "thread-1", submissionId: "sub/1" }),
    ).resolves.toEqual({ kind: "retired", submissionId: "sub/1", code: "retired" });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/threads/thread-1/admissions/sub%2F1", {
      method: "GET",
    });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/threads/thread-1/admissions/sub%2F1", {
      method: "DELETE",
    });
  });
});
