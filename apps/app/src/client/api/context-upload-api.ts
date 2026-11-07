/**
 * The browser's side of the one upload route, `/context/{scheme}/upload`: a chat attach is
 * `scheme=uploads` with the chat in the query, a file dropped into a document is the document's
 * own source (and a Work's id for its Scratch). Removing a reference never deletes the file.
 */
import {
  type DeleteDraftUploadInput,
  type DeleteDraftUploadResult,
  MAX_UPLOAD_BYTES,
  type StartUploadInput,
  type UploadIntakeResult,
  type UploadStart,
} from "@meridian/contracts/protocol";

import type { ComposerUploadPort } from "@/components/app/composer";
import { fileTooLargeMessage } from "@/lib/upload-limit";

import { UploadRefusedError, uploadFileDirect } from "./direct-upload";
import { jsonPost, uploadResponse } from "./upload-request";

export type ContextUploadTarget = {
  projectId: string;
  scheme: string;
  /** `chatId` for a chat's uploads, `workId` for a Work's Scratch; nothing otherwise. */
  query: Readonly<Record<string, string>>;
  /** Minted by the caller: a document's link to the file stands before the file does. */
  intakeId: string;
  file: File;
};

function url(target: Omit<ContextUploadTarget, "intakeId" | "file">, step = "") {
  const query = new URLSearchParams(target.query);
  return `/api/projects/${encodeURIComponent(target.projectId)}/context/${encodeURIComponent(target.scheme)}/upload${step}?${query}`;
}

/** Reserves the upload, or resumes it. A refusal (a name, a size) rejects with the writer's words. */
export function startContextUpload(target: ContextUploadTarget): Promise<UploadStart> {
  const { file, intakeId } = target;
  if (file.size > MAX_UPLOAD_BYTES)
    return Promise.reject(new UploadRefusedError(fileTooLargeMessage(file.name)));
  const body: StartUploadInput = {
    intakeId,
    filename: file.name,
    sizeBytes: file.size,
    // The signed PUT carries the type exactly; the server answers with the header to send.
    mimeType: file.type || "application/octet-stream",
  };
  return uploadResponse<UploadStart>(fetch(url(target), jsonPost(body)));
}

export function uploadContextFile(
  target: ContextUploadTarget & {
    signal: AbortSignal;
    /** Whole percents, or null where the browser cannot say how much there is to send. */
    onProgress?: (percent: number | null) => void;
  },
): Promise<UploadIntakeResult> {
  return uploadFileDirect({
    file: target.file,
    signal: target.signal,
    onProgress: target.onProgress,
    start: () => startContextUpload(target),
    finish: () =>
      uploadResponse<UploadIntakeResult>(
        fetch(url(target, "/finish"), jsonPost({ intakeId: target.intakeId })),
      ),
  });
}

/** A chat's attach: the file waits in the chat's flat `uploads` for a send. */
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

/**
 * Deletes one unused upload the writer attached to a chat. The server refuses a file a sent
 * message has used (`already_used`) and one whose identity no longer stands (`identity_mismatch`).
 */
export function deleteChatUpload(
  scope: { projectId: string; chatId: string },
  identity: DeleteDraftUploadInput,
): Promise<DeleteDraftUploadResult> {
  return uploadResponse<DeleteDraftUploadResult>(
    fetch(url({ projectId: scope.projectId, scheme: "uploads", query: { chatId: scope.chatId } }), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(identity),
    }),
  );
}
