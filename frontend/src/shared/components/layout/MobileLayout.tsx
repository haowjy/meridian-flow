import { useEffect, useMemo, Activity } from "react";
import { useLocation, useParams } from "@tanstack/react-router";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { useUIStore, type MobileTab } from "@/core/stores/useUIStore";
import { MobileBottomBar } from "./MobileBottomBar";
import { MobileDocumentView } from "@/features/documents/components/MobileDocumentView";
import { MobileThreadsView } from "@/features/threads/components/MobileThreadsView";
import { MobileActiveThreadView } from "@/features/threads/components/MobileActiveThreadView";
import { MobileProjectSettingsView } from "@/features/projects/components/MobileProjectSettingsView";
import type { LayoutStrategyProps } from "./types";

/**
 * Derives the initial mobile tab from URL path.
 * Used on first load/navigation to set the correct tab based on deep links.
 */
function deriveTabFromPath(pathname: string): MobileTab {
  // Document URLs: /projects/$slug/documents/$
  // Skill URLs: /projects/$slug/skills/$skillName
  // Tree URL: /projects/$slug/tree
  if (pathname.includes("/documents/")) return "documents";
  if (pathname.includes("/skills/")) return "documents";
  if (pathname.endsWith("/tree")) return "documents";
  // Threads URL: /projects/$slug/threads
  if (pathname.endsWith("/threads")) return "threads";
  // Default: chat (e.g., /projects/$slug)
  return "chat";
}

// MobileLayout renders its own mobile-specific wrapper components directly (MobileThreadsView,
// MobileActiveThreadView, MobileDocumentView, MobileProjectSettingsView), so it doesn't use
// the panels prop. The prop is required by LayoutStrategyProps for desktop layout compatibility.
export function MobileLayout(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  { panels, className, leftPanelView }: LayoutStrategyProps,
) {
  const location = useLocation();
  const params = useParams({ strict: false });
  const projectSlug = params.slug as string | undefined;

  // Get project ID from route params or store
  const currentProject = useProjectStore((s) =>
    projectSlug
      ? s.projects.find((p) => p.slug === projectSlug || p.id === projectSlug)
      : s.currentProject(),
  );
  const projectId = currentProject?.id ?? "";

  // Get mobile active tab from store (state-driven, not URL-driven)
  const mobileActiveTab = useUIStore((s) => s.mobileActiveTab);
  const setMobileActiveTab = useUIStore((s) => s.setMobileActiveTab);

  // Derive initial tab from URL on first load (deep link support)
  const initialTabFromUrl = useMemo(
    () => deriveTabFromPath(location.pathname),
    // Only compute on first render, URL changes shouldn't switch tabs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Set initial tab based on URL (only once on mount)
  useEffect(() => {
    setMobileActiveTab(initialTabFromUrl);
  }, [initialTabFromUrl, setMobileActiveTab]);

  return (
    <div className="flex h-full flex-col md:hidden">
      {/* Content area - all views mounted using React 19.2's Activity component.
          Activity pauses effects when hidden and defers updates for better performance. */}
      <div className="relative flex-1 overflow-hidden">
        <Activity mode={mobileActiveTab === "threads" ? "visible" : "hidden"}>
          <div className="absolute inset-0">
            {projectId && <MobileThreadsView projectId={projectId} />}
          </div>
        </Activity>
        <Activity mode={mobileActiveTab === "chat" ? "visible" : "hidden"}>
          <div className="absolute inset-0">
            {projectId && <MobileActiveThreadView projectId={projectId} />}
          </div>
        </Activity>
        <Activity mode={mobileActiveTab === "documents" ? "visible" : "hidden"}>
          <div className="absolute inset-0">
            {projectId && (
              <MobileDocumentView
                projectId={projectId}
                projectSlug={projectSlug ?? ""}
              />
            )}
          </div>
        </Activity>
        <Activity
          mode={mobileActiveTab === "projectSettings" ? "visible" : "hidden"}
        >
          <div className="absolute inset-0">
            {projectId && <MobileProjectSettingsView projectId={projectId} />}
          </div>
        </Activity>
      </div>

      <MobileBottomBar activeTab={mobileActiveTab} />
    </div>
  );
}
