import { useState, useEffect, useRef, Activity } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/shared/components/ui/resizable";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { useUIStore } from "@/core/stores/useUIStore";
import type { LayoutStrategyProps } from "./types";

/**
 * Two-panel desktop layout strategy for AI-native, writer-first design.
 *
 * Layout: [Chat/Threads (42%)] | [Documents (58%)]
 *
 * - Left panel (Chat): Non-collapsible anchor, always visible - AI conversation is central
 * - Right panel (Documents): Collapsible overlay that can be dismissed
 *
 * When documents panel is collapsed, chat expands to ~95%.
 *
 * Uses react-resizable-panels for adjustable widths.
 * Default sizes: 42% | 58% (when all expanded)
 *
 * Design Philosophy:
 * - Chat is the anchor (non-collapsible) - AI conversation is central to the workflow
 * - Documents are dismissible context - can be collapsed when focusing on conversation
 * - Shadow falls from documents onto chat (docs appear "on top", floating overlay feel)
 * - User can resize or collapse documents based on current workflow
 *
 * Panel visibility:
 * - Left (chat): Always visible, cannot be collapsed
 * - Right (documents): Auto-collapsed while loading, auto-expands when ready
 * - User override takes precedence for documents panel
 */
export function TwoPanelLayout({
  panels,
  className,
  leftPanelView = "chat",
}: LayoutStrategyProps) {
  // Subscribe to RAW values that affect collapsed state for the RIGHT (documents) panel.
  // Left panel is now the anchor (always visible), right panel is collapsible.
  const { rightPanelUserOverride, rightPanelReady } = useUIStore(
    useShallow((s) => ({
      rightPanelUserOverride: s.rightPanelUserOverride,
      rightPanelReady: s.rightPanelReady,
    })),
  );

  // Compute collapsed state for the right (documents) panel.
  // This is the collapsible panel now - left is always visible.
  const effectiveRightCollapsed =
    rightPanelUserOverride === "collapsed" ||
    (rightPanelUserOverride === null && !rightPanelReady);

  // Imperative ref for collapse/expand API (panel must always stay mounted)
  // See: https://github.com/bvaughn/react-resizable-panels/issues/285
  const rightRef = useRef<ImperativePanelHandle | null>(null);
  const isDraggingRef = useRef(false);
  // Track initial sync to catch localStorage divergence from store state
  const initialSyncDone = useRef(false);
  // Track resizing state for conditional animations - only animate when NOT dragging
  // This prevents CSS transitions from interfering with manual drag operations
  const [isResizing, setIsResizing] = useState(false);

  // Sync store state → panel ref (imperative API)
  // Skip during active drag to prevent race conditions
  useEffect(() => {
    if (isDraggingRef.current) return;

    // Force sync on first render to handle localStorage divergence
    // react-resizable-panels restores size from autoSaveId, which may conflict with store
    if (!initialSyncDone.current) {
      initialSyncDone.current = true;
      // Small delay to let library initialize from localStorage
      requestAnimationFrame(() => {
        if (effectiveRightCollapsed) rightRef.current?.collapse();
        else rightRef.current?.expand();
      });
      return;
    }

    if (effectiveRightCollapsed) rightRef.current?.collapse();
    else rightRef.current?.expand();
  }, [effectiveRightCollapsed]);

  return (
    <div
      className={cn("relative flex h-full w-full overflow-hidden", className)}
    >
      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId="workspace:two-panel:v2"
      >
        {/* Left Panel (Chat) - non-collapsible anchor, always visible.
            Chat is the central communication hub - it should never disappear. */}
        <ResizablePanel
          id="workspace-chat-panel"
          order={1}
          minSize={40}
          defaultSize={42}
          collapsible={false}
          className="workspace-panel-left"
        >
          {/* Left panel content - all views stay mounted to preserve scroll position.
              Uses React 19.2's Activity component to pause effects when hidden. */}
          <div className="relative h-full w-full overflow-hidden">
            <Activity mode={leftPanelView === "chat" ? "visible" : "hidden"}>
              <div className="absolute inset-0">{panels.activeThread}</div>
            </Activity>
            <Activity mode={leftPanelView === "threads" ? "visible" : "hidden"}>
              <div className="absolute inset-0">{panels.threadList}</div>
            </Activity>
            {panels.projectSettings && (
              <Activity
                mode={
                  leftPanelView === "projectSettings" ? "visible" : "hidden"
                }
              >
                <div className="absolute inset-0">{panels.projectSettings}</div>
              </Activity>
            )}
          </div>
        </ResizablePanel>

        {/* Conditionally render handle only when documents panel is expanded.
            When handle is always present, react-resizable-panels can't collapse to 0%
            because it maintains sizing constraints for drag operations. */}
        {!effectiveRightCollapsed && (
          <ResizableHandle
            className="after:!bg-sidebar-border"
            onDragging={(isDragging) => {
              isDraggingRef.current = isDragging;
              setIsResizing(isDragging);
            }}
          />
        )}

        {/* Right Panel (Documents) - collapsible overlay that can be dismissed.
            Documents are context for the conversation - they can be collapsed to focus on chat.
            Shadow falls LEFT onto chat to create floating overlay visual effect. */}
        <ResizablePanel
          id="workspace-document-panel"
          order={2}
          ref={rightRef}
          className={cn(
            "workspace-panel-right",
            !isResizing && "transition-all duration-200 ease-out",
            // Shadow falls LEFT onto chat - documents appear "on top"
            // Enhanced shadow for more visible floating effect
            !effectiveRightCollapsed &&
              "z-10 shadow-[-6px_0_16px_rgba(0,0,0,0.12)]",
          )}
          collapsible
          collapsedSize={0}
          minSize={25}
          maxSize={60}
          defaultSize={58}
          onCollapse={() => {
            // Sync library state → store (user dragged to collapse)
            // Use getState() for fresh read to avoid stale closure
            const state = useUIStore.getState();
            const currentCollapsed =
              state.rightPanelUserOverride === "collapsed" ||
              (state.rightPanelUserOverride === null && !state.rightPanelReady);
            if (!currentCollapsed) {
              useUIStore.setState({ rightPanelUserOverride: "collapsed" });
            }
          }}
          onExpand={() => {
            // Sync library state → store (user dragged to expand)
            // Use getState() for fresh read to avoid stale closure
            const state = useUIStore.getState();
            const currentCollapsed =
              state.rightPanelUserOverride === "collapsed" ||
              (state.rightPanelUserOverride === null && !state.rightPanelReady);
            if (currentCollapsed) {
              useUIStore.setState({ rightPanelUserOverride: "expanded" });
            }
          }}
        >
          <div className="h-full overflow-hidden">{panels.documentPanel}</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
