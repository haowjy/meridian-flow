/** The kind of a failed Apply or Discard is read from the error's type and envelope, never its message. */
import { describe, expect, it } from "vitest";

import { HttpResponseError, MeridianApiError } from "@/client/api/http-client";
import { classifyDraftCommandRejection } from "./draft-command-rejection";

const envelope = (message: string) => ({
  code: "work_archived",
  message,
  source: "system" as const,
  retryable: false,
});

describe("classifyDraftCommandRejection", () => {
  it("reads a typed server refusal as a refusal, with the server's reason", () => {
    const error = new MeridianApiError(envelope("This Work is archived and read-only."), 403);
    expect(classifyDraftCommandRejection(error)).toEqual({
      kind: "refused",
      reason: "This Work is archived and read-only.",
    });
  });

  it("keeps a typed refusal that sends no reason, without inventing one", () => {
    expect(classifyDraftCommandRejection(new MeridianApiError(envelope("  "), 403))).toEqual({
      kind: "refused",
      reason: undefined,
    });
  });

  it("reads an HTTP error with no typed envelope as a server error, whatever its message says", () => {
    expect(
      classifyDraftCommandRejection(new HttpResponseError("Failed to fetch", 502, null)),
    ).toEqual({ kind: "server-error" });
  });

  it("reads a request that got no HTTP answer as offline", () => {
    expect(classifyDraftCommandRejection(new TypeError("Failed to fetch"))).toEqual({
      kind: "offline",
    });
    expect(classifyDraftCommandRejection(new Error("Draft command was not sent"))).toEqual({
      kind: "offline",
    });
  });
});
