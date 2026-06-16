/** GET /api/packages/catalog: promoted first-party package gallery entries. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { handleGetPackagesCatalogRequest } from "../../../../lib/packages-catalog-route.js";

export default defineEventHandler(async (event) => {
  await requireAppUser(event);
  return serializeTransport(handleGetPackagesCatalogRequest());
});
