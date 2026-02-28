import { Home, MessageSquare, List, Settings } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  useUserProfile,
  useAuthActions,
  UserMenuButton,
} from "@/features/auth";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useUIStore,
  selectEffectiveLeftCollapsed,
} from "@/core/stores/useUIStore";

interface WorkspaceRailProps {
  className?: string;
  // Space-specific props (undefined when at /projects)
  projectSlug?: string;
}

/**
 * Vertical navigation rail (desktop only).
 *
 * Phase 2: Minimal (user only) at /projects
 * Phase 3: Full navigation (home, chat, threads, user) in space
 */
export function WorkspaceRail({ className, projectSlug }: WorkspaceRailProps) {
  const navigate = useNavigate();
  const { profile, status } = useUserProfile();
  const { signOut } = useAuthActions();

  // Read left panel view and collapse state from store (only relevant in space)
  const leftPanelView = useUIStore((s) => s.leftPanelView);
  const setLeftPanelView = useUIStore((s) => s.setLeftPanelView);
  const toggleLeftPanel = useUIStore((s) => s.toggleLeftPanel);
  const isExpanded = !useUIStore(selectEffectiveLeftCollapsed);

  // Check if we're in a space (project context)
  const inWorkspace = !!projectSlug;

  /**
   * Smart toggle handler for rail buttons.
   * - Click active view when expanded -> collapse panel
   * - Click active view when collapsed -> expand panel
   * - Click different view -> switch view AND expand if collapsed
   */
  const handleViewClick = (
    targetView: "chat" | "threads" | "projectSettings",
  ) => {
    const store = useUIStore.getState();
    const currentlyCollapsed = selectEffectiveLeftCollapsed(store);

    if (targetView === leftPanelView) {
      // Same view clicked - toggle collapse/expand
      toggleLeftPanel();
    } else {
      // Different view clicked - switch view AND expand if collapsed
      setLeftPanelView(targetView);
      if (currentlyCollapsed) {
        toggleLeftPanel(); // Expand to show new view
      }
    }
  };

  return (
    <div
      className={cn(
        "bg-background hidden h-full w-12 shrink-0 flex-col items-center border-r md:flex",
        className,
      )}
    >
      {inWorkspace && (
        <>
          {/* Header zone - 48px to align with ProjectHeader */}
          <div
            className="flex shrink-0 items-center justify-center"
            style={{ height: "var(--panel-header-height)" }}
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => navigate({ to: "/projects" })}
              aria-label="Back to projects"
            >
              <Home className="size-4" />
            </Button>
          </div>

          {/* Content zone - Thread/Chat toggles */}
          <div className="flex flex-col items-center gap-1 pt-2">
            {/* Thread List */}
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "size-8",
                // Only highlight when expanded AND active view
                isExpanded && leftPanelView === "threads" && "bg-muted",
              )}
              onClick={() => handleViewClick("threads")}
              aria-label="Thread list"
            >
              <List className="size-4" />
            </Button>

            {/* Chat View */}
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "size-8",
                // Only highlight when expanded AND active view
                isExpanded && leftPanelView === "chat" && "bg-muted",
              )}
              onClick={() => handleViewClick("chat")}
              aria-label="Chat view"
            >
              <MessageSquare className="size-4" />
            </Button>

            {/* Project Settings */}
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "size-8",
                // Only highlight when expanded AND active view
                isExpanded && leftPanelView === "projectSettings" && "bg-muted",
              )}
              onClick={() => handleViewClick("projectSettings")}
              aria-label="Project settings"
            >
              <Settings className="size-4" />
            </Button>
          </div>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom zone - User only (settings accessible via menu) */}
      <div className="flex flex-col items-center gap-1 pb-2">
        {status === "authenticated" && profile && (
          <UserMenuButton
            profile={profile}
            onSignOut={signOut}
            menuSide="right"
            showName={false}
          />
        )}
      </div>
    </div>
  );
}
