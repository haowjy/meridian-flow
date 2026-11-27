import {
  MAX_UPLOAD_BYTES,
  type StartUploadInput,
  type UploadIntakeResult,
  type UploadStart,
} from "@meridian/contracts/protocol";

import { fileTooLargeMessage } from "@/lib/upload-limit";

import { UploadRefusedError, uploadFileDirect } from "./direct-upload";
import { apiFetch } from "./http-client";
import { jsonPost, uploadResponse } from "./upload-request";

type ContextUploadTarget = {
  projectId: string;
  scheme: string;
  query: Readonly<Record<string, string>>;
  intakeId: string;
  file: File;
};

function url(target: Omit<ContextUploadTarget, "intakeId" | "file">, step = "") {
  const query = new URLSearchParams(target.query);
  return `/api/projects/${encodeURIComponent(target.projectId)}/context/${encodeURIComponent(target.scheme)}/upload${step}?${query}`;
}

export function startContextUpload(
  target: ContextUploadTarget,
  signal?: AbortSignal,
): Promise<UploadStart> {
  const { file, intakeId } = target;
  if (file.size > MAX_UPLOAD_BYTES)
    return Promise.reject(new UploadRefusedError(fileTooLargeMessage()));
  const body: StartUploadInput = {
    intakeId,
    filename: file.name,
    sizeBytes: file.size,
    // The signed PUT carries the type exactly; the server answers with the header to send.
    mimeType: file.type || "application/octet-stream",
  };
  return uploadResponse<UploadStart>(apiFetch(url(target), { ...jsonPost(body), signal }));
}

export function uploadContextFile(
  target: ContextUploadTarget & {
    signal: AbortSignal;
    onProgress?: (percent: number | null) => void;
  },
): Promise<UploadIntakeResult> {
  return uploadFileDirect({
    file: target.file,
    signal: target.signal,
    onProgress: target.onProgress,
    start: (signal) => startContextUpload(target, signal),
    finish: (signal) =>
      uploadResponse<UploadIntakeResult>(
        apiFetch(url(target, "/finish"), { ...jsonPost({ intakeId: target.intakeId }), signal }),
      ),
  });
}
