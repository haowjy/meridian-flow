/**
 * Proto route — THROWAWAY palette explorer at /proto/palette.
 *
 * Public, no auth. Disposable UI exploration for tuning the tonal relationship
 * between sidebar/dock chrome and the center manuscript. Live-overrides eight
 * ground CSS vars on `:root`; never modifies the shared token CSS file.
 */
import { createFileRoute } from "@tanstack/react-router";

import { PalettePrototypeShell } from "@/features/proto/palette/PalettePrototypeShell";

export const Route = createFileRoute("/proto/palette")({
  component: PalettePrototypeShell,
});
