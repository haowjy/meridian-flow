// @ts-nocheck
/**
 * workbench-source — the single SSR/browser loader for the sidebar workbench list.
 *
 * Route loaders call `loadWorkbenchList` during SSR (forwarding cookies) so the
 * shell renders the API-authoritative list on first paint; the browser falls
 * back to the same HTTP client after hydration. Owns workbench-list fetching.
 */
import type { Workbench } from "@meridian/contracts/workbenches";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import { listWorkbenches } from "@/client/api/workbenches-api";

/**
 * The single source of the sidebar's workbench list.
 *
 * Route loaders call this during SSR so the authenticated shell can render
 * the API-authoritative workbench list on first paint. The browser fallback
 * path uses the same HTTP client after hydration when this server fetch fails.
 */
export async function loadWorkbenchList(): Promise<Workbench[]> {
  return listWorkbenches(ssrApiRequestInit());
}
