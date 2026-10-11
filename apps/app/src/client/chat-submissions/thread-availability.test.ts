/** Only a typed owner-gate disappearance authorizes discarding local words. */
import { expect, it } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { MeridianApiError } from "@/client/api/meridian-error";
import { isThreadNotFound, probeChatDestination } from "./thread-availability";

const missing = () =>
  new MeridianApiError(
    { code: "thread_not_found", message: "Thread not found", retryable: false, source: "system" },
    404,
  );
it("recognizes the owner code, not messages or bare 404s", () => {
  expect(isThreadNotFound(missing())).toBe(true);
  expect(isThreadNotFound(new HttpResponseError("Thread not found", 404, null))).toBe(false);
});
it.each([
  new HttpResponseError("Submission not found", 404, null),
  new MeridianApiError(
    { code: "not_found", message: "not seen", retryable: false, source: "system" },
    404,
  ),
  new HttpResponseError("server", 500, null),
  new HttpResponseError("auth", 401, null),
  new TypeError("network"),
  new DOMException("timeout", "TimeoutError"),
])("keeps copies on an inconclusive answer (%s)", async (error) => {
  expect(
    await probeChatDestination("chat", async () => {
      throw error;
    }),
  ).toBe("unknown");
});
it("keeps 200 and timed-out lookup, forgets only owner-gate 404", async () => {
  expect(
    await probeChatDestination("chat", async () => ({ kind: "not-seen", submissionId: "probe" })),
  ).toBe("unknown");
  expect(
    await probeChatDestination("chat", async () => {
      throw missing();
    }),
  ).toBe("missing");
  expect(
    await probeChatDestination("chat", () => new Promise(() => {}), AbortSignal.timeout(1)),
  ).toBe("unknown");
});
