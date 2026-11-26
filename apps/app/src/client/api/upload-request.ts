import { t } from "@lingui/core/macro";

import { fileTooLargeMessage } from "@/lib/upload-limit";

import { UploadRefusedError } from "./direct-upload";
import { errorMessageFromPayload, readResponsePayload } from "./http-client";
import { meridianApiErrorFromPayload } from "./meridian-error";

export const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function uploadResponse<T>(request: Promise<Response>): Promise<T> {
  const value = await request.catch((cause: unknown) => {
    throw cause instanceof TypeError ? new Error(t`Couldn't reach the server`, { cause }) : cause;
  });
  const payload = await readResponsePayload(value);
  if (!value.ok) {
    const message =
      typeof payload === "object" && payload && "message" in payload ? payload.message : null;
    if (message === "invalid_filename")
      throw new UploadRefusedError(t`Couldn't upload`, { cause: message });
    if (message === "too_large") throw new UploadRefusedError(fileTooLargeMessage());
    throw (
      meridianApiErrorFromPayload(payload, value.status) ??
      new Error(errorMessageFromPayload(payload, value.status))
    );
  }
  return payload as T;
}
