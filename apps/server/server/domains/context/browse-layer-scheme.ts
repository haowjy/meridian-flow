/**
 * Browse-layer scheme mapping: HTTP routes and UI still expose legacy `fs1`
 * while the unified ContextPort uses `manuscript://`. Centralizes that flip.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

/** Map browse-layer route scheme to the unified ContextPort scheme. */
export function browseLayerContextScheme(
  scheme: ProjectContextTreeScheme,
): ProjectContextTreeScheme | "manuscript" {
  return scheme === "fs1" ? "manuscript" : scheme;
}

/** Build a canonical context URI from a browse-layer scheme + relative path. */
export function projectBrowseContextUri(scheme: ProjectContextTreeScheme, path: string): string {
  const contextScheme = browseLayerContextScheme(scheme);
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `${contextScheme}://${normalized}` : `${contextScheme}://`;
}
