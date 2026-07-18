/** Production-shaped HTTP failure coverage for the shared API boundary. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "./http-client";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP failure boundary", () => {
  it("preserves status and payload from a plain Nitro JSON error", async () => {
    const payload = { statusCode: 401, statusMessage: "Unauthorized", message: "Unauthorized" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    const request = postJson("/api/project/project-1/context/move/scratch", {});

    await expect(request).rejects.toMatchObject({
      name: "HttpResponseError",
      status: 401,
      payload,
    });
  });
});
