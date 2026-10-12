/** Only a typed owner-gate disappearance authorizes discarding local words. */
import { expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { MeridianApiError } from "@/client/api/meridian-error";
import { isThreadMissingForAccount, probeChatDestination } from "./thread-availability";

const missing = () =>
  new MeridianApiError(
    {
      code: "thread_not_found",
      details: { authenticatedUserId: "writer" },
      message: "Thread not found",
      retryable: false,
      source: "system",
    },
    404,
  );
it("recognizes the owner code, not messages or bare 404s", () => {
  expect(isThreadMissingForAccount(missing(), "writer")).toBe(true);
  expect(
    isThreadMissingForAccount(new HttpResponseError("Thread not found", 404, null), "writer"),
  ).toBe(false);
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
    await probeChatDestination("writer", "chat", "probe", async () => {
      throw error;
    }),
  ).toBe("unknown");
});
it("keeps 200 and timed-out lookup, forgets only owner-gate 404", async () => {
  expect(
    await probeChatDestination("writer", "chat", "probe", async () => ({
      kind: "not-seen",
      submissionId: "probe",
    })),
  ).toBe("unknown");
  expect(
    await probeChatDestination("writer", "chat", "probe", async () => {
      throw missing();
    }),
  ).toBe("missing");
  expect(
    await probeChatDestination(
      "writer",
      "chat",
      "probe",
      () => new Promise(() => {}),
      AbortSignal.timeout(1),
    ),
  ).toBe("unknown");
});

it("requires the authenticated journal principal, including when attestation is absent", () => {
  vi.stubGlobal("reportError", vi.fn());
  expect(isThreadMissingForAccount(missing(), "other-writer")).toBe(false);
  expect(
    isThreadMissingForAccount(
      new MeridianApiError(
        {
          code: "thread_not_found",
          message: "missing",
          retryable: false,
          source: "system",
        },
        404,
      ),
      "writer",
    ),
  ).toBe(false);
});
