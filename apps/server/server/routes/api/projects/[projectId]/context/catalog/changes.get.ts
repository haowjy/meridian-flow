/** Bounded whole-commit replay from an opaque catalog cursor. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import {
  optionalPositiveSafeIntegerQuery,
  requiredQueryString,
  resolveCatalogRoute,
} from "./_helpers.js";

export default defineEventHandler(async (event) => {
  const { app, query, scope } = await resolveCatalogRoute(event);
  const cursor = requiredQueryString(query, "cursor");
  const limit = optionalPositiveSafeIntegerQuery(query, "limit");
  return serializeTransport(await app.contextCatalog.changes(scope, cursor, limit));
});
