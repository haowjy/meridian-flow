/** Pure policy for deriving a usable Work from an owned-project catalog. */
import type { Work } from "@meridian/contracts/works";

export type WorkCatalogRead =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; works: readonly Work[] };

export type CatalogWorkResolution =
  | { status: "loading" }
  | { status: "error" }
  | { status: "empty" }
  | { status: "ready"; work: Work };

export function resolveCatalogWork(read: WorkCatalogRead): CatalogWorkResolution {
  if (read.status !== "ready") return read;
  const work = read.works.find(({ status }) => status === "active") ?? read.works[0];
  return work ? { status: "ready", work } : { status: "empty" };
}
