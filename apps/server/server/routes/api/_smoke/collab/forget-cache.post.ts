import type { DocumentId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { getApp } from "../../../../lib/app.js";
import { forgetYjsDocumentCache } from "../../../ws/yjs.js";

type ForgetCacheBody = {
  documentId?: string;
};

export default defineEventHandler(async (event) => {
  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 404, statusMessage: "Not Found" });
  }

  const body = (await readBody(event)) as ForgetCacheBody;
  const documentId = body.documentId;
  if (!documentId) {
    throw createError({ statusCode: 400, statusMessage: "documentId is required" });
  }

  const app = await getApp();
  app.documentSync.forgetMirror?.(documentId as DocumentId);
  await forgetYjsDocumentCache(documentId);

  return { ok: true, documentId };
});
