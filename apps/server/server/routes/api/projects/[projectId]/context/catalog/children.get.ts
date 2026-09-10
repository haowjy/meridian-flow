/** Direct children projection over the catalog's normalized entries. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requiredQueryString, resolveCatalogRoute } from "./_helpers.js";

export default defineEventHandler(async (event) => {
  const { app, query, scope } = await resolveCatalogRoute(event);
  const parentId = requiredQueryString(query, "parentId");
  return serializeTransport(await app.contextCatalog.children({ scope, parentId }));
});
