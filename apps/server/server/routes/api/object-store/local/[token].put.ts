import { Readable } from "node:stream";
import {
  createError,
  defineEventHandler,
  getRequestHeader,
  getRouterParam,
  setResponseStatus,
} from "nitro/h3";
import { getApp } from "../../../../lib/app.js";

/** A browser's PUT to a URL from `signPut`: the token carries the key, length and type. */
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, "token") ?? "";
  const { localObjectStore } = await getApp();
  if (!localObjectStore)
    throw createError({ statusCode: 404, message: "Local object store is not enabled" });
  const length = getRequestHeader(event, "content-length");
  const body = event.req.body;
  const result = await localObjectStore.writeSignedToken(token, {
    body: body ? Readable.fromWeb(body as never) : Readable.from([]),
    contentLength: length && /^\d+$/.test(length) ? Number(length) : null,
    contentType: getRequestHeader(event, "content-type") ?? null,
  });
  if (!result.ok)
    throw createError({
      statusCode: result.error.code === "io_error" ? 500 : 403,
      message: result.error.message,
    });
  setResponseStatus(event, 200);
  return null;
});
