/**
 * Proto route — stable-identity layout spike at /proto/spike-layout.
 *
 * Public, no auth. THROWAWAY. Used to make the GO/NO-GO call on building a
 * custom CSS-grid + reverse-portal project that replaces
 * react-resizable-panels. The spec for the gates lives in
 * `work/platform/plan-stable-identity-layout.md`.
 */
import { createFileRoute } from "@tanstack/react-router";

import { SpikeLayoutShell } from "@/features/proto/spike-layout/SpikeLayoutShell";

export const Route = createFileRoute("/proto/spike-layout")({
  component: SpikeLayoutShell,
});
