/**
 * Proto route — tabbed right dock with work-scoped Changes tab.
 * Public, no auth. Disposable mockup at /proto/dock-tabs.
 */
import { createFileRoute } from "@tanstack/react-router";

import { DockTabsShell } from "@/features/proto/dock-tabs/DockTabsShell";

export const Route = createFileRoute("/proto/dock-tabs")({
  component: DockTabsShell,
});
