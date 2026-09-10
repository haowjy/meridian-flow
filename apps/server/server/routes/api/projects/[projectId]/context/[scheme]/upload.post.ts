/** Multipart transport adapter for authoritative UploadIntake. */
import type { UploadIntakeResult } from "@meridian/contracts/protocol";
import {
  createError,
  defineEventHandler,
  readMultipartFormData,
  setResponseStatus,
} from "nitro/h3";
import { resolveContextRoute } from "./_helpers.js";

function field(parts: Awaited<ReturnType<typeof readMultipartFormData>>, name: string): string {
  const value = parts?.find((part) => part.name === name && !part.filename)?.data;
  return value ? Buffer.from(value).toString("utf8").trim() : "";
}

export default defineEventHandler(async (event): Promise<UploadIntakeResult> => {
  const { app, userId, projectId, scheme, workId } = await resolveContextRoute(event);
  if (scheme !== "uploads")
    throw createError({ statusCode: 400, message: "Upload intake requires uploads" });
  const parts = await readMultipartFormData(event);
  const file = parts?.find((part) => part.name === "file" && part.filename);
  if (!file?.filename)
    throw createError({ statusCode: 400, message: "multipart field 'file' is required" });
  const intakeId = field(parts, "intakeId");
  const byteDigest = field(parts, "byteDigest").toLowerCase();
  if (!intakeId || !/^[0-9a-f]{64}$/.test(byteDigest)) {
    throw createError({ statusCode: 400, message: "intakeId and SHA-256 byteDigest are required" });
  }
  const result = await app.uploadIntake.intake({
    intakeId,
    actorUserId: userId,
    owner: workId ? { kind: "work", projectId, workId } : { kind: "none", projectId },
    filename: file.filename,
    mimeType: file.type ?? "application/octet-stream",
    byteDigest,
    bytes: file.data,
  });
  if (!result.ok) {
    const statusCode =
      result.error.code === "idempotency_conflict"
        ? 409
        : result.error.code === "owner_unavailable"
          ? 404
          : 502;
    throw createError({ statusCode, message: result.error.code });
  }
  setResponseStatus(event, 201);
  return result.value;
});
