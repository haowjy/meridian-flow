/** Only a typed owner-gate disappearance authorizes discarding local words. */
import { expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { MeridianApiError } from "@/client/api/meridian-error";
import { probeChatDestination, threadAvailability } from "./thread-availability";

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
  expect(threadAvailability(missing(), "writer")).toBe("not-found");
  expect(threadAvailability(new HttpResponseError("Thread not found", 404, null), "writer")).toBe(
    null,
  );
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
  ).toBe("present");
  expect(
    await probeChatDestination("writer", "chat", "probe", async () => {
      throw missing();
    }),
  ).toBe("not-found");
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
  expect(threadAvailability(missing(), "other-writer")).toBe(null);
  expect(
    threadAvailability(
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
  ).toBe(null);
});

it("classifies deleted chats and projects only with matching attestation", () => {
  for (const [code, details, expected] of [
    ["thread_deleted", {}, "deleted"],
    ["thread_deleted", { projectDeleted: true }, "project-deleted"],
    ["project_deleted", {}, "project-deleted"],
  ] as const) {
    const error = new MeridianApiError(
      {
        code,
        details: { ...details, authenticatedUserId: "writer" },
        message: "gone",
        source: "system",
        retryable: false,
      },
      404,
    );
    expect(threadAvailability(error, "writer")).toBe(expected);
    expect(threadAvailability(error, "other")).toBe(null);
  }
});
