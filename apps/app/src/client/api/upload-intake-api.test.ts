/** Upload failures preserve their structured API identity through the intake adapter. */
import { afterEach, expect, it, vi } from "vitest";
import { MeridianApiError } from "./meridian-error";
import { uploadIntakePort } from "./upload-intake-api";

afterEach(() => vi.unstubAllGlobals());
it("decodes the structured upload error response", async () => {
  const payload = {
    kind: "error",
    error: {
      code: "project_deleted",
      message: "project_deleted",
      retryable: false,
      source: "system",
      details: { authenticatedUserId: "owner" },
    },
  };
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify(payload), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  );
  const result = uploadIntakePort.intake({
    file: new File(["words"], "draft.txt"),
    intakeId: "intake",
    scope: { kind: "chat", projectId: "deleted", chatId: "chat" },
  });
  await expect(result).rejects.toBeInstanceOf(MeridianApiError);
  await expect(result).rejects.toMatchObject({
    code: "project_deleted",
    retryable: false,
    source: "system",
    details: { authenticatedUserId: "owner" },
    status: 404,
  });
});
