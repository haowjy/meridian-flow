import { useState, useEffect, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/core/stores/useUIStore'
import { makeLogger } from '@/core/lib/logger'
import { cn } from '@/lib/utils'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/shared/components/ui/resizable'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import { DocumentTreeContainer } from './DocumentTreeContainer'
import { EditorPanel } from './EditorPanel'
import { SkillEditorPanel, SkillCreatePanel } from '@/features/skills/components'
import { DocumentHeaderBar } from './DocumentHeaderBar'
import { DocumentTreeToggle } from '@/shared/components/layout'
import { ProjectHeader } from './ProjectHeader'

const logger = makeLogger('document-panel')

interface DocumentPanelProps {
  projectId: string
  projectSlug: string
  isLoadingSkills?: boolean
  effectiveSkillName?: string
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
export function DocumentPanel({ projectId, projectSlug, isLoadingSkills, effectiveSkillName }: DocumentPanelProps) {
  const { documentTreeCollapsed, activeDocumentId, activeSkillId } = useUIStore(useShallow((s) => ({
    documentTreeCollapsed: s.documentTreeCollapsed,
    activeDocumentId: s.activeDocumentId,
    activeSkillId: s.activeSkillId,
  })))

  // Refs and state for resizable panel control
  const treeRef = useRef<ImperativePanelHandle | null>(null)
  const isDraggingRef = useRef(false)
  const [isResizing, setIsResizing] = useState(false)

  // Sync store collapse state to panel imperatively
  useEffect(() => {
    if (isDraggingRef.current) return // Don't interfere during drag

    if (documentTreeCollapsed) {
      treeRef.current?.collapse()
    } else {
      treeRef.current?.expand()
    }
  }, [documentTreeCollapsed])

  // Handle panel collapse (via drag to edge or double-click)
  const handleTreeCollapse = useCallback(() => {
    const { documentTreeCollapsed, setDocumentTreeCollapsed } = useUIStore.getState()
    if (!documentTreeCollapsed) {
      setDocumentTreeCollapsed(true)
    }
  }, [])

  // Handle panel expand (via drag or imperative expand() call from button)
  // Since the inner handle is only rendered when tree is expanded, this callback
  // now only fires from: (1) user dragging handle when tree is visible, or
  // (2) imperative expand() from the toggle button.
  const handleTreeExpand = useCallback(() => {
    useUIStore.getState().setDocumentTreeCollapsed(false)
  }, [])

  // Determine which component to render for the editor panel
  // 'new' is a reserved skill name for the creation flow
  const isCreatingNewSkill = effectiveSkillName === 'new'

  logger.debug('[SKILL-DEEPLINK] DocumentPanel rendering', {
    activeSkillId,
    activeDocumentId,
    documentTreeCollapsed,
    effectiveSkillName,
    isCreatingNewSkill,
    willRender: isCreatingNewSkill ? 'SkillCreatePanel' : activeSkillId ? 'SkillEditorPanel' : activeDocumentId ? 'EditorPanel' : 'fallback',
  })

  return (
    <div className="flex h-full flex-col">
      {/* Project Header - unified header for the entire document zone */}
      <ProjectHeader projectId={projectId} />

      {/* Document Workspace - Tree + Editor */}
      <div className="flex flex-1 overflow-hidden border-r border-border/50">
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
              'document-tree-panel',
              !isResizing && 'transition-all duration-200 ease-out'
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
              className="w-px bg-sidebar-border"
              onDragging={(isDragging) => {
                isDraggingRef.current = isDragging
                setIsResizing(isDragging)
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
            <div className="h-full bg-background">
              {/* Skill creation mode - URL is /skills/new */}
              {isCreatingNewSkill ? (
                <SkillCreatePanel projectId={projectId} projectSlug={projectSlug} />
              ) : /* Show loading skeleton if skill is being resolved from URL */
              isLoadingSkills && effectiveSkillName && !activeSkillId ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-muted-foreground">Loading skill...</p>
                </div>
              ) : activeSkillId ? (
                <SkillEditorPanel skillId={activeSkillId} projectId={projectId} projectSlug={projectSlug} />
              ) : activeDocumentId ? (
                <EditorPanel documentId={activeDocumentId} />
              ) : (
                <div className="flex flex-col h-full bg-background">
                  {/* Consistent header using DocumentHeaderBar */}
                  <DocumentHeaderBar
                    leading={documentTreeCollapsed ? <DocumentTreeToggle /> : undefined}
                    title={
                      <span className="text-sm text-muted-foreground">
                        No document selected
                      </span>
                    }
                    ariaLabel="Document editor"
                    showDivider={false}
                  />
                  {/* Empty content area */}
                  <div className="flex-1" />
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
