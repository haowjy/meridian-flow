/** Browser adapter for authoritative material intake and identity-bound draft deletion. */
import type { DeleteDraftUploadResult, UploadIntakeResult } from "@meridian/contracts/protocol";
import type {
  ComposerOwnedUpload,
  ComposerUploadPort,
  ComposerUploadScope,
} from "@/components/app/composer";
import { readResponsePayload } from "./http-client";

function url(scope: ComposerUploadScope) {
  const query = scope.kind === "work" ? `?workId=${encodeURIComponent(scope.workId)}` : "";
  return `/api/projects/${encodeURIComponent(scope.projectId)}/context/uploads/upload${query}`;
}
async function response<T>(request: Promise<Response>): Promise<T> {
  const value = await request;
  const payload = await readResponsePayload(value);
  if (!value.ok)
    throw new Error(
      typeof payload === "object" && payload && "message" in payload
        ? String(payload.message)
        : `Upload request failed: ${value.status}`,
    );
  return payload as T;
}
export const uploadIntakePort: ComposerUploadPort = {
  async intake({ file, intakeId, scope }) {
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const form = new FormData();
    form.set("file", file);
    form.set("intakeId", intakeId);
    form.set("byteDigest", digest);
    return response<UploadIntakeResult>(fetch(url(scope), { method: "POST", body: form }));
  },
  async deleteDraft(upload: ComposerOwnedUpload, scope: ComposerUploadScope) {
    await response<DeleteDraftUploadResult>(
      fetch(url(scope), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intakeId: upload.intakeId,
          documentId: upload.documentId,
          uri: upload.uri,
          expectedRevision: upload.locationRevision,
        }),
      }),
    );
  },
};
