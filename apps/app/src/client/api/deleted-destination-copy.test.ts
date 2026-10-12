/** Fetch, figure XHR, material intake and metadata feedback agree on deleted-destination copy. */
import { expect, it, vi } from "vitest";
import { workUpdateFailure } from "@/client/query/work-update-failure";
import { errorMessageFromPayload } from "./http-client";
import { MeridianApiError } from "./meridian-error";

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
it("maps both codes in every server envelope shape, never showing the raw code", () => {
  for (const code of ["thread_deleted", "project_deleted"] as const) {
    const envelope = { code, message: code, source: "system" as const, retryable: false };
    const expected =
      code === "thread_deleted" ? "This chat was deleted." : "This project was deleted.";
    const error = new MeridianApiError(envelope, 404);
    expect(error.message).toBe(expected);
    expect(workUpdateFailure(error, "generic failure")).toBe(expected);
    for (const payload of [envelope, { kind: "error", error: envelope }, { data: envelope }])
      expect(errorMessageFromPayload(payload, 404)).toBe(expected);
  }
  const projectThread = {
    code: "thread_deleted",
    details: { projectDeleted: true },
    message: "thread_deleted",
    source: "system" as const,
    retryable: false,
  };
  const error = new MeridianApiError(projectThread, 404);
  expect(error.message).toBe("This project was deleted.");
  expect(workUpdateFailure(error, "generic")).toBe("This project was deleted.");
  expect(errorMessageFromPayload({ kind: "error", error: projectThread }, 404)).toBe(
    "This project was deleted.",
  );
});
