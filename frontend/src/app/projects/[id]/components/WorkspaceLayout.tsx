"use client"

import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PanelLayout } from '@/shared/components/layout/PanelLayout'
import { CollapsiblePanel } from '@/shared/components/layout/CollapsiblePanel'
import { useUIStore } from '@/core/stores/useUIStore'
import { DocumentPanel } from '@/features/documents/components/DocumentPanel'

interface WorkspaceLayoutProps {
  projectId: string
}

export default function WorkspaceLayout({ projectId }: WorkspaceLayoutProps) {
  const [mounted, setMounted] = useState(false)

  const {
    leftPanelCollapsed,
    rightPanelCollapsed,
    toggleLeftPanel,
    toggleRightPanel,
    setActiveDocument,
    setRightPanelState,
  } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: s.leftPanelCollapsed,
    rightPanelCollapsed: s.rightPanelCollapsed,
    toggleLeftPanel: s.toggleLeftPanel,
    toggleRightPanel: s.toggleRightPanel,
    setActiveDocument: s.setActiveDocument,
    setRightPanelState: s.setRightPanelState,
  })))

  useEffect(() => {
    setMounted(true)
  }, [])

  // Reset UI state when project changes to prevent context leakage
  useEffect(() => {
    setActiveDocument(null)
    setRightPanelState('documents')
  }, [projectId, setActiveDocument, setRightPanelState])

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


