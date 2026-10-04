/** Complete compact metadata snapshot for one authorized catalog scope. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { catalogScopeAccess, resolveCatalogRoute } from "./_helpers.js";

export default defineEventHandler(async (event) => {
  const { app, scope, userId } = await resolveCatalogRoute(event);
  const [snapshot, access] = await Promise.all([
    app.contextCatalog.snapshot(scope),
    catalogScopeAccess(app, userId, scope),
  ]);
  return serializeTransport(access ? { ...snapshot, access } : snapshot);
});
