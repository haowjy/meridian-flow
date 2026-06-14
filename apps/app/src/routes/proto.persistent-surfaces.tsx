/**
 * Proto route — lifted persistent surfaces (chat + document).
 * Public, no auth. Disposable mockup at /proto/persistent-surfaces.
 *
 * Proves chat and document surfaces can live above the destination switch,
 * survive remount-free navigation, and animate/reparent between geometries.
 */
import { createFileRoute } from "@tanstack/react-router";

import { PersistentSurfacesShell } from "@/features/proto/persistent-surfaces/PersistentSurfacesShell";

export const Route = createFileRoute("/proto/persistent-surfaces")({
  component: PersistentSurfacesShell,
});
