/**
 * Purpose: Verifies interrupt HTTP failures serialize the envelope as the response body (not h3's wrapper).
 */
import { httpErrorInterruptBody, wsErrorInterruptPayload } from "@meridian/contracts/protocol";
import { H3, toWebHandler } from "nitro/h3";
import { describe, expect, it } from "vitest";
import { throwHttpInterruptForStatus } from "./interrupt-boundary.js";
import interruptErrorHandler from "./interrupt-error-handler.js";

function createInterruptTestApp() {
  const app = new H3({
    onError: (error, event) => interruptErrorHandler(error, event) ?? undefined,
  });
  app.get("/thread-missing", () => {
    throwHttpInterruptForStatus(404, "Thread not found");
  });
  return toWebHandler(app);
}

describe("interrupt HTTP boundary", () => {
  it("serializes the interrupt envelope as the top-level HTTP response body", async () => {
    const handler = createInterruptTestApp();
    const response = await handler(new Request("http://localhost/thread-missing"));
    const body = (await response.json()) as ReturnType<typeof httpErrorInterruptBody>;

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toEqual({
      kind: "error",
      error: {
        code: "not_found",
        message: "Thread not found",
        retryable: false,
        source: "system",
      },
    });

    const wsBody = wsErrorInterruptPayload(body.error, "thread_1");
    expect(body).toEqual(httpErrorInterruptBody(wsBody.error));
  });
});
