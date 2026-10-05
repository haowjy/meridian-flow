/** Complete compact metadata snapshot for one authorized catalog scope. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { resolveCatalogRoute } from "./_helpers.js";

export default defineEventHandler(async (event) => {
  const { app, scope } = await resolveCatalogRoute(event);
  return serializeTransport(await app.contextCatalog.snapshot(scope));
});
