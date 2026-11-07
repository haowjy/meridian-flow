/**
 * Sends a file dropped into a document to its project: the file lands in `assets/` of the
 * document's own source (a picture, in `manuscript`'s). `startSourceUpload` reserves it, so the
 * server knows the file's id before a link to it stands in any document; `uploadSourceFile` then
 * puts the bytes straight to the store and finishes.
 */
import type {
  StartUploadInput,
  UploadIntakeResult,
  UploadStart,
} from "@meridian/contracts/protocol";

import { fileTooLargeMessage } from "@/lib/upload-limit";

import { uploadFileDirect } from "./direct-upload";
import { jsonPost, uploadResponse } from "./upload-request";

/** The tab sending a file starts it again this often, so other tabs' chips know it is still on its way. */
const KEEP_ALIVE_MS = 60_000;

export type SourceUploadTarget = {
  projectId: string;
  /** The host document's source: the file lands in that source's `assets/`. */
  scheme: string;
  /** Which Work's Scratch a `scratch` host means. */
  owner: { workId: string } | null;
  /** Minted by the caller: the link to the file stands in the document before the file does. */
  documentId: string;
  file: File;
};

function url(target: SourceUploadTarget, step = "") {
  const query = new URLSearchParams();
  if (target.owner) query.set("workId", target.owner.workId);
  return `/api/projects/${encodeURIComponent(target.projectId)}/context/${encodeURIComponent(target.scheme)}/upload${step}?${query}`;
}

/** Reserves the upload. A refusal (a name, a size) rejects here, before any chip stands for the file. */
export function startSourceUpload(target: SourceUploadTarget): Promise<UploadStart> {
  const { file, documentId } = target;
  const body: StartUploadInput = {
    intakeId: documentId,
    filename: file.name,
    sizeBytes: file.size,
    // The signed PUT carries the type exactly; the server answers with the header to send.
    mimeType: file.type || "application/octet-stream",
  };
  return uploadResponse<UploadStart>(fetch(url(target), jsonPost(body)), () =>
    fileTooLargeMessage(file.name),
  );
}

export async function uploadSourceFile(
  target: SourceUploadTarget & {
    /** What `startSourceUpload` answered; the first start of the upload is not asked twice. */
    started: UploadStart;
    signal: AbortSignal;
    /** Whole percents, or null where the browser cannot say how much there is to send. */
    onProgress: (percent: number | null) => void;
  },
): Promise<UploadIntakeResult> {
  let first: UploadStart | null = target.started;
  const keepAlive = setInterval(
    () => void startSourceUpload(target).catch(() => {}),
    KEEP_ALIVE_MS,
  );
  try {
    return await uploadFileDirect({
      file: target.file,
      signal: target.signal,
      onProgress: target.onProgress,
      start: () => {
        const started = first;
        first = null;
        return started ? Promise.resolve(started) : startSourceUpload(target);
      },
      finish: () =>
        uploadResponse<UploadIntakeResult>(
          fetch(url(target, "/finish"), jsonPost({ intakeId: target.documentId })),
          () => fileTooLargeMessage(target.file.name),
        ),
    });
  } finally {
    clearInterval(keepAlive);
  }
}
