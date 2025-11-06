"use client"

import { useEffect, useState, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PanelLayout } from '@/shared/components/layout/PanelLayout'
import { CollapsiblePanel } from '@/shared/components/layout/CollapsiblePanel'
import { useUIStore } from '@/core/stores/useUIStore'
import { DocumentPanel } from '@/features/documents/components/DocumentPanel'
import { useTreeStore } from '@/core/stores/useTreeStore'

interface WorkspaceLayoutProps {
  projectId: string
  initialDocumentId?: string
}

export default function WorkspaceLayout({ projectId, initialDocumentId }: WorkspaceLayoutProps) {
  const [mounted, setMounted] = useState(false)
  const previousDocumentIdRef = useRef<string | undefined>(undefined)

  const {
    leftPanelCollapsed,
    rightPanelCollapsed,
    rightPanelState,
    activeDocumentId,
    toggleLeftPanel,
    toggleRightPanel,
    setActiveDocument,
    setRightPanelState,
    setRightPanelCollapsed,
  } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: s.leftPanelCollapsed,
    rightPanelCollapsed: s.rightPanelCollapsed,
    rightPanelState: s.rightPanelState,
    activeDocumentId: s.activeDocumentId,
    toggleLeftPanel: s.toggleLeftPanel,
    toggleRightPanel: s.toggleRightPanel,
    setActiveDocument: s.setActiveDocument,
    setRightPanelState: s.setRightPanelState,
    setRightPanelCollapsed: s.setRightPanelCollapsed,
  })))

  // Ensure document tree is loaded when deep-linking to a document URL
  const { isTreeLoading, documentsCount, documents, loadTree } = useTreeStore(useShallow((s) => ({
    isTreeLoading: s.isLoading,
    documentsCount: s.documents.length,
    documents: s.documents,
    loadTree: s.loadTree,
  })))

  useEffect(() => {
    setMounted(true)
  }, [])

  // Reset UI state when project changes to prevent context leakage
  useEffect(() => {
    setActiveDocument(null)
    setRightPanelState('documents')
    previousDocumentIdRef.current = undefined // Reset ref so next URL is treated as changed
  }, [projectId, setActiveDocument, setRightPanelState])

  // Sync URL document ID to UI state (for direct URL navigation, bookmarks, browser back/forward)
  // Only sync when URL actually changes to prevent overriding manual view toggles
  useEffect(() => {
    const urlChanged = previousDocumentIdRef.current !== initialDocumentId
    // Record the current URL doc id immediately to avoid repeated triggers
    previousDocumentIdRef.current = initialDocumentId

    if (!urlChanged) {
      return
    }

    if (initialDocumentId) {
      // Document URL - open editor with this document and ensure sidebar open
      if (activeDocumentId !== initialDocumentId) {
        setActiveDocument(initialDocumentId)
      }
      if (rightPanelState !== 'editor') {
        setRightPanelState('editor')
      }
      if (rightPanelCollapsed) {
        setRightPanelCollapsed(false)
      }
    } else {
      // Tree URL - show tree view
      if (activeDocumentId !== null) {
        setActiveDocument(null)
      }
      if (rightPanelState !== 'documents') {
        setRightPanelState('documents')
      }
    }
  }, [initialDocumentId, activeDocumentId, rightPanelState, rightPanelCollapsed, setActiveDocument, setRightPanelState, setRightPanelCollapsed])

  // For deep links: load the tree once in the background if empty
  useEffect(() => {
    if (!initialDocumentId) return
    if (documentsCount !== 0 || isTreeLoading) return

    const abortController = new AbortController()
    loadTree(projectId, abortController.signal)
    return () => abortController.abort()
  }, [projectId, initialDocumentId])

  // After the tree loads, ensure the active document selection reflects the tree entry
  useEffect(() => {
    if (!initialDocumentId) return
    if (documentsCount === 0) return

    const existsInTree = documents.some((d) => d.id === initialDocumentId)
    if (existsInTree && activeDocumentId !== initialDocumentId) {
      setActiveDocument(initialDocumentId)
    }
  }, [documentsCount, documents, initialDocumentId, activeDocumentId, setActiveDocument])

  if (!mounted) {
    return <div className="h-screen w-full bg-background" />
  }

  return (
    <div className="h-screen w-full overflow-hidden">
      <PanelLayout
        leftCollapsed={leftPanelCollapsed}
        rightCollapsed={rightPanelCollapsed}
        onLeftCollapse={toggleLeftPanel}
        onRightCollapse={toggleRightPanel}
        left={
          <CollapsiblePanel
            side="left"
            collapsed={leftPanelCollapsed}
            onToggle={toggleLeftPanel}
          >
            <div className="p-4 text-sm text-muted-foreground">
              Left panel placeholder (Chat list)
            </div>
          </CollapsiblePanel>
        }
        center={
          <div className="flex h-full flex-col overflow-hidden">
            <div className="flex-1 overflow-auto p-4 text-muted-foreground">
              Center panel placeholder (Actual chat)
            </div>
          </div>
        }
        right={
          <CollapsiblePanel
            side="right"
            collapsed={rightPanelCollapsed}
            onToggle={toggleRightPanel}
          >
            <DocumentPanel projectId={projectId} />
          </CollapsiblePanel>
        }
      />
    </div>
  )
}
