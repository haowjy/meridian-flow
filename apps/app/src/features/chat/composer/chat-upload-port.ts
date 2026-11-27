import { uploadContextFile } from "@/client/api/context-upload-api";
import type { ComposerUploadPort } from "./Composer";

export const chatUploadPort: ComposerUploadPort = {
  intake: ({ file, intakeId, scope, signal }) =>
    uploadContextFile({
      projectId: scope.projectId,
      scheme: "uploads",
      query: { chatId: scope.chatId },
      intakeId,
      file,
      signal,
    }),
};
