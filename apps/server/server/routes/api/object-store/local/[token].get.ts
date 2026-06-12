import { Readable } from "node:stream";
import { createError, defineEventHandler, getRouterParam, sendStream, setHeader } from "nitro/h3";
import { getApp } from "../../../../lib/app.js";
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, "token") ?? "";
  const { localObjectStore } = await getApp();
  if (!localObjectStore)
    throw createError({ statusCode: 404, message: "Local object store is not enabled" });
  const result = await localObjectStore.readSignedToken(token);
  if (!result.ok)
    throw createError({
      statusCode: result.error.code === "not_found" ? 404 : 403,
      message: result.error.message,
    });
  setHeader(event, "Content-Type", result.value.mimeType);
  setHeader(event, "Content-Length", String(result.value.sizeBytes));
  setHeader(event, "Cache-Control", "private, max-age=60");
  return sendStream(event, Readable.toWeb(result.value.stream) as unknown as ReadableStream);
});
