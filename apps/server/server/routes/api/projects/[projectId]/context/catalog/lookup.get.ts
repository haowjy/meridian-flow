/** Stable-ID or canonical-URI lookup over one authorized catalog scope. */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler } from "nitro/h3";
import { resolveCatalogRoute } from "./_helpers.js";

export default defineEventHandler(async (event) => {
  const { app, query, scope } = await resolveCatalogRoute(event);
  const entryId = typeof query.entryId === "string" && query.entryId ? query.entryId : null;
  const uri = typeof query.uri === "string" && query.uri ? query.uri : null;
  if (Boolean(entryId) === Boolean(uri)) {
    throw createError({ statusCode: 400, message: "Provide exactly one of entryId or uri" });
  }
  if (uri) {
    const parsed = parseUnifiedContextUri(uri);
    if (!parsed.ok || parsed.value.normalized !== uri) {
      throw createError({ statusCode: 400, message: "uri must be a canonical context URI" });
    }
  }
  const input = entryId ? ({ scope, entryId } as const) : ({ scope, uri: uri as string } as const);
  return serializeTransport(await app.contextCatalog.lookup(input));
});
