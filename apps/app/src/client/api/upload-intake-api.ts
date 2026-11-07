/** Browser adapter for authoritative material intake; removing a reference never deletes the file. */
import { t } from "@lingui/core/macro";
import {
  type DeleteDraftUploadInput,
  type DeleteDraftUploadResult,
  MAX_UPLOAD_BYTES,
  type StartUploadInput,
  type UploadIntakeResult,
  type UploadStart,
} from "@meridian/contracts/protocol";
import type { ComposerUploadPort, ComposerUploadScope } from "@/components/app/composer";
import { uploadFileDirect } from "./direct-upload";
import { jsonPost, uploadResponse } from "./upload-request";

function url(scope: Pick<ComposerUploadScope, "projectId" | "chatId">, path = "") {
  return `/api/projects/${encodeURIComponent(scope.projectId)}/context/uploads/upload${path}?chatId=${encodeURIComponent(scope.chatId)}`;
}
const LIMIT_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
const tooLarge = () => t`Files over ${LIMIT_MB} MB can't be attached.`;
const response = <T>(request: Promise<Response>) => uploadResponse<T>(request, tooLarge);
export const uploadIntakePort: ComposerUploadPort = {
  intake({ file, intakeId, scope, signal }) {
    if (file.size > MAX_UPLOAD_BYTES) return Promise.reject(new Error(tooLarge()));
    const start: StartUploadInput = {
      intakeId,
      filename: file.name,
      sizeBytes: file.size,
      // The signed PUT carries the type exactly; the server answers with the header to send.
      mimeType: file.type || "application/octet-stream",
    };
    return uploadFileDirect({
      file,
      signal,
      start: () => response<UploadStart>(fetch(url(scope), jsonPost(start))),
      finish: () =>
        response<UploadIntakeResult>(fetch(url(scope, "/finish"), jsonPost({ intakeId }))),
    });
  },
};

/**
 * Deletes one unused upload the writer attached to a chat. The server refuses a file a sent
 * message has used (`already_used`) and one whose identity no longer stands (`identity_mismatch`).
 */
export function deleteChatUpload(
  scope: Pick<ComposerUploadScope, "projectId" | "chatId">,
  identity: DeleteDraftUploadInput,
): Promise<DeleteDraftUploadResult> {
  return response<DeleteDraftUploadResult>(
    fetch(url(scope), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(identity),
    }),
  );
}
