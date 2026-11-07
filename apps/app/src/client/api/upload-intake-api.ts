/** Browser adapter for authoritative material intake; removing a reference never deletes the file. */
import { t } from "@lingui/core/macro";
import {
  type DeleteDraftUploadInput,
  type DeleteDraftUploadResult,
  MAX_UPLOAD_BYTES,
  type UploadIntakeResult,
} from "@meridian/contracts/protocol";
import type { ComposerUploadPort, ComposerUploadScope } from "@/components/app/composer";
import { errorMessageFromPayload, readResponsePayload } from "./http-client";

import { meridianApiErrorFromPayload } from "./meridian-error";

function url(scope: Pick<ComposerUploadScope, "projectId" | "chatId">) {
  return `/api/projects/${encodeURIComponent(scope.projectId)}/context/uploads/upload?chatId=${encodeURIComponent(scope.chatId)}`;
}
const LIMIT_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
const tooLarge = () => t`Files over ${LIMIT_MB} MB can't be attached.`;
async function response<T>(request: Promise<Response>): Promise<T> {
  const value = await request.catch((cause: unknown) => {
    // `fetch` rejects with a bare TypeError ("Failed to fetch") when the network is down.
    throw cause instanceof TypeError
      ? new Error(t`Couldn't reach the server. Check your connection.`, { cause })
      : cause;
  });
  const payload = await readResponsePayload(value);
  if (!value.ok) {
    if (
      typeof payload === "object" &&
      payload &&
      "message" in payload &&
      payload.message === "invalid_filename"
    ) {
      throw new Error(
        t`This filename contains unsupported characters. Rename the file and attach it again.`,
      );
    }
    if (
      typeof payload === "object" &&
      payload &&
      "message" in payload &&
      payload.message === "too_large"
    )
      throw new Error(tooLarge());
    throw (
      meridianApiErrorFromPayload(payload, value.status) ??
      new Error(errorMessageFromPayload(payload, value.status))
    );
  }
  return payload as T;
}
export const uploadIntakePort: ComposerUploadPort = {
  async intake({ file, intakeId, scope }) {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(tooLarge());
    // The file is the body, streamed from disk; the server reads name and chat from the query.
    const query = `&intakeId=${encodeURIComponent(intakeId)}&filename=${encodeURIComponent(file.name)}`;
    return response<UploadIntakeResult>(
      fetch(url(scope) + query, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      }),
    );
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
