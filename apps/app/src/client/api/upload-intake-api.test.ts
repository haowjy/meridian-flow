/** Upload failures preserve canonical project deletion copy and filename guidance. */
import { afterEach, expect, it, vi } from "vitest";
import { uploadIntakePort } from "./upload-intake-api";

afterEach(() => vi.unstubAllGlobals());
it.each([
  [
    {
      kind: "error",
      error: {
        code: "project_deleted",
        message: "project_deleted",
        retryable: false,
        source: "system",
        details: { authenticatedUserId: "owner" },
      },
    },
    "This project was deleted.",
  ],
  [
    { message: "invalid_filename" },
    "This filename contains unsupported characters. Rename the file and attach it again.",
  ],
])("decodes the actual upload error response %j", async (payload, message) => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify(payload), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  );
  await expect(
    uploadIntakePort.intake({
      file: new File(["words"], "draft.txt"),
      intakeId: "intake",
      scope: { kind: "chat", projectId: "deleted", chatId: "chat" },
    }),
  ).rejects.toThrow(message);
});
