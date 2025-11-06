"use client"

import { useEffect, useState, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PanelLayout } from '@/shared/components/layout/PanelLayout'
import { CollapsiblePanel } from '@/shared/components/layout/CollapsiblePanel'
import { useUIStore } from '@/core/stores/useUIStore'
import { DocumentPanel } from '@/features/documents/components/DocumentPanel'

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
    toggleLeftPanel,
    toggleRightPanel,
    setActiveDocument,
    setRightPanelState,
    setRightPanelCollapsed,
  } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: s.leftPanelCollapsed,
    rightPanelCollapsed: s.rightPanelCollapsed,
    toggleLeftPanel: s.toggleLeftPanel,
    toggleRightPanel: s.toggleRightPanel,
    setActiveDocument: s.setActiveDocument,
    setRightPanelState: s.setRightPanelState,
    setRightPanelCollapsed: s.setRightPanelCollapsed,
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
    // Check if the URL actually changed
    const urlChanged = previousDocumentIdRef.current !== initialDocumentId

    if (!urlChanged) {
      // URL didn't change, user just toggled view manually - don't override
      return
    }

    // URL changed - sync view to match new URL
    if (initialDocumentId) {
      // Document URL - open editor with this document
      setActiveDocument(initialDocumentId)
      setRightPanelState('editor')
      setRightPanelCollapsed(false)
    } else {
      // Tree URL - show tree view
      setActiveDocument(null)
      setRightPanelState('documents')
    }

    // Update ref to track this URL for next comparison
    previousDocumentIdRef.current = initialDocumentId
  }, [initialDocumentId, setActiveDocument, setRightPanelState, setRightPanelCollapsed])

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


