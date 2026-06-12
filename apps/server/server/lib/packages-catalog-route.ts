/**
 * First-party package catalog route core: promoted gallery entries for install UI.
 */
import type { FirstPartyCatalogResponse } from "@meridian/contracts/agents";
import { listFirstPartyCatalog } from "../domains/packages/index.js";

export function handleGetPackagesCatalogRequest(): FirstPartyCatalogResponse {
  return { packages: listFirstPartyCatalog() };
}
