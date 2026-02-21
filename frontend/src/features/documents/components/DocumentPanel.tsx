import { useState, useEffect, useRef, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useUIStore } from "@/core/stores/useUIStore";
import { cn } from "@/lib/utils";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/shared/components/ui/resizable";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { DocumentTreeContainer } from "./DocumentTreeContainer";
import { EditorPanel } from "./EditorPanel";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import {
  SkillEditorPanel,
  SkillCreatePanel,
} from "@/features/skills/components";
import { PanelHeader } from "@/shared/components/layout/headers";
import { DocumentTreeToggle } from "@/shared/components/layout";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectHomeView } from "./ProjectHomeView";

interface DocumentPanelProps {
  projectId: string;
  projectSlug: string;
  isLoadingSkills?: boolean;
  effectiveSkillName?: string;
  /** True when URL has a document path but ID hasn't resolved yet (tree loading) */
  isResolvingDocument?: boolean;
}

/**
 * Split layout for document/skill experience.
 * Shows tree (resizable, collapsible) + editor side-by-side.
 *
 * Tree Panel:
 * - Resizable via drag handle (15-50% of panel width)
 * - Collapsible via button in tree header or drag to edge
 * - Size preference auto-saved to localStorage
 *
 * Editor Panel:
 * - Shows document, skill, or welcome message based on activeDocumentId/activeSkillId
 * - Shows loading skeleton when skill is being resolved from URL
 */
export function DocumentPanel({
  projectId,
  projectSlug,
  isLoadingSkills,
  effectiveSkillName,
  isResolvingDocument,
}: DocumentPanelProps) {
  const {
    documentTreeCollapsed,
    activeDocumentId,
    activeSkillId,
    showVersionHistory,
  } = useUIStore(
    useShallow((s) => ({
      documentTreeCollapsed: s.documentTreeCollapsed,
      activeDocumentId: s.activeDocumentId,
      activeSkillId: s.activeSkillId,
      showVersionHistory: s.showVersionHistory,
    })),
  );

  // Refs and state for resizable panel control
  const treeRef = useRef<ImperativePanelHandle | null>(null);
  const isDraggingRef = useRef(false);
  const [isResizing, setIsResizing] = useState(false);

  // Sync store collapse state to panel imperatively
  useEffect(() => {
    if (isDraggingRef.current) return; // Don't interfere during drag

    if (documentTreeCollapsed) {
      treeRef.current?.collapse();
    } else {
      treeRef.current?.expand();
    }
  }, [documentTreeCollapsed]);

  // Handle panel collapse (via drag to edge or double-click)
  const handleTreeCollapse = useCallback(() => {
    const { documentTreeCollapsed, setDocumentTreeCollapsed } =
      useUIStore.getState();
    if (!documentTreeCollapsed) {
      setDocumentTreeCollapsed(true);
    }
  }, []);

  // Handle panel expand (via drag or imperative expand() call from button)
  // Since the inner handle is only rendered when tree is expanded, this callback
  // now only fires from: (1) user dragging handle when tree is visible, or
  // (2) imperative expand() from the toggle button.
  const handleTreeExpand = useCallback(() => {
    useUIStore.getState().setDocumentTreeCollapsed(false);
  }, []);

  // Determine which component to render for the editor panel
  // 'new' is a reserved skill name for the creation flow
  const isCreatingNewSkill = effectiveSkillName === "new";

  return (
    <div className="flex h-full flex-col">
      {/* Project Header - unified header for the entire document zone */}
      <ProjectHeader projectId={projectId} projectSlug={projectSlug} />

      {/* Document Workspace - Tree + Editor */}
      <div className="border-border/50 flex flex-1 overflow-hidden border-r">
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="workspace:tree-editor:v1"
          className="h-full"
        >
          {/* Tree Panel - Resizable */}
          <ResizablePanel
            id="document-tree-panel"
            order={1}
            ref={treeRef}
            minSize={15}
            maxSize={50}
            defaultSize={25}
            collapsible
            collapsedSize={0}
            onCollapse={handleTreeCollapse}
            onExpand={handleTreeExpand}
            className={cn(
              "document-tree-panel",
              !isResizing && "transition-all duration-200 ease-out",
            )}
          >
            <DocumentTreeContainer
              projectId={projectId}
              projectSlug={projectSlug}
            />
          </ResizablePanel>

          {/* Resize Handle - only render when tree is expanded.
              Without a handle, the inner ResizablePanelGroup can't resize the tree panel,
              preventing spurious expansion when the outer panel is resized. */}
          {!documentTreeCollapsed && (
            <ResizableHandle
              className="bg-sidebar-border w-px"
              onDragging={(isDragging) => {
                isDraggingRef.current = isDragging;
                setIsResizing(isDragging);
              }}
            />
          )}

          {/* Editor Panel - Takes remaining space */}
          <ResizablePanel
            id="document-editor-panel"
            order={2}
            minSize={50}
            defaultSize={75}
            collapsible={false}
          >
            <div className="bg-background flex h-full">
              {/* Main content area */}
              <div className="min-w-0 flex-1">
                {/* Skill creation mode - URL is /skills/new */}
                {isCreatingNewSkill ? (
                  <SkillCreatePanel
                    projectId={projectId}
                    projectSlug={projectSlug}
                  />
                ) : /* Blank space while skill is being resolved from URL (tree loading) */
                isLoadingSkills && effectiveSkillName && !activeSkillId ? (
                  <div className="bg-background flex h-full flex-col">
                    <PanelHeader
                      leading={
                        documentTreeCollapsed ? (
                          <DocumentTreeToggle />
                        ) : undefined
                      }
                      ariaLabel="Skill editor"
                      showGradient={false}
                    />
                    <div className="flex-1" />
                  </div>
                ) : activeSkillId ? (
                  <SkillEditorPanel
                    skillId={activeSkillId}
                    projectId={projectId}
                    projectSlug={projectSlug}
                  />
                ) : activeDocumentId ? (
                  <EditorPanel documentId={activeDocumentId} />
                ) : isResolvingDocument ? (
                  /* Blank state while document path is resolving to ID (tree loading) */
                  <div className="bg-background flex h-full flex-col">
                    <PanelHeader
                      leading={
                        documentTreeCollapsed ? (
                          <DocumentTreeToggle />
                        ) : undefined
                      }
                      ariaLabel="Document editor"
                      showGradient={false}
                    />
                    <div className="flex-1" />
                  </div>
                ) : (
                  <div className="bg-background flex h-full flex-col">
                    {/* Only show header when tree is collapsed (for toggle button) */}
                    {documentTreeCollapsed && (
                      <PanelHeader
                        leading={<DocumentTreeToggle />}
                        ariaLabel="Project home"
                        showGradient={false}
                      />
                    )}
                    {/* Project home content */}
                    <ProjectHomeView
                      projectId={projectId}
                      projectSlug={projectSlug}
                    />
                  </div>
                )}
              </div>

              {/* Version History Panel — slides in from right */}
              {showVersionHistory && activeDocumentId && (
                <div className="w-64 shrink-0">
                  <VersionHistoryPanel documentId={activeDocumentId} />
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
