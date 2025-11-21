"use client"

import { useEffect, useState, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PanelLayout } from '@/shared/components/layout/PanelLayout'
import { CollapsiblePanel } from '@/shared/components/layout/CollapsiblePanel'
import { useUIStore } from '@/core/stores/useUIStore'
import { DocumentPanel } from '@/features/documents/components/DocumentPanel'
import { ChatListPanel } from '@/features/chats/components/ChatListPanel'
import { ActiveChatView } from '@/features/chats/components/ActiveChatView'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { api } from '@/core/lib/api'
import { makeLogger } from '@/core/lib/logger'

const logger = makeLogger('workspace-layout')

interface WorkspaceLayoutProps {
  projectId: string
  initialDocumentId?: string
}

export default function WorkspaceLayout({ projectId, initialDocumentId }: WorkspaceLayoutProps) {
  const [mounted, setMounted] = useState(false)
  const previousDocumentIdRef = useRef<string | undefined>(undefined)
  const previousProjectIdRef = useRef<string | undefined>(undefined)

  // Subscribe only to panel collapse state (needed for PanelLayout props)
  // Use getState() in effects to read other values without subscribing
  const {
    leftPanelCollapsed,
    rightPanelCollapsed,
    toggleLeftPanel,
    toggleRightPanel,
  } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: s.leftPanelCollapsed,
    rightPanelCollapsed: s.rightPanelCollapsed,
    toggleLeftPanel: s.toggleLeftPanel,
    toggleRightPanel: s.toggleRightPanel,
  })))

  // Ensure document tree is loaded when deep-linking to a document URL
  const { isTreeLoading, documentsCount, documents, loadTree } = useTreeStore(useShallow((s) => ({
    isTreeLoading: s.isLoading,
    documentsCount: s.documents.length,
    documents: s.documents,
    loadTree: s.loadTree,
  })))

  // Projects store to centralize current project for the workspace
  const {
    projects,
    currentProjectId,
    setCurrentProject,
  } = useProjectStore(useShallow((s) => ({
    projects: s.projects,
    currentProjectId: s.currentProjectId,
    setCurrentProject: s.setCurrentProject,
  })))

  useEffect(() => {
    setMounted(true)
  }, [])

  // Ensure the workspace has the current project set and present in the store
  useEffect(() => {
    // Prevent duplicate work for the same project id
    if (previousProjectIdRef.current === projectId) return
    previousProjectIdRef.current = projectId

    let ignore = false
    const abortController = new AbortController()

    async function ensureProject() {
      // Try to find the project in the existing list first
      const existing = projects.find((p) => p.id === projectId)

      let project = existing
      if (!project) {
        try {
          project = await api.projects.get(projectId, { signal: abortController.signal })
        } catch (e) {
          // Non-fatal for the layout; header will fallback until projects page refreshes
          // Errors are surfaced elsewhere when listing projects.
        }
      }

      if (!ignore && project) {
        // Switch context only if different to avoid unnecessary editor cache clears
        if (currentProjectId !== project.id) {
          setCurrentProject(project)
        }
      }
    }

    ensureProject()
    return () => {
      ignore = true
      abortController.abort()
    }
    // Intentionally depend only on projectId and stable setters to avoid constant re-runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Reset UI state when project changes to prevent context leakage
  useEffect(() => {
    const store = useUIStore.getState()
    store.setActiveDocument(null)
    store.setRightPanelState('documents')
    previousDocumentIdRef.current = undefined // Reset ref so next URL is treated as changed
  }, [projectId])

  // Sync URL document ID to UI state (for direct URL navigation, bookmarks, browser back/forward)
  // Uses getState() to read current values without subscribing (prevents unnecessary re-runs)
  // Effect only runs when document URL param changes, not when UI state changes
  // This allows future chat effects to run independently without interfering
  useEffect(() => {
    logger.debug('URL sync effect triggered', {
      previousDocId: previousDocumentIdRef.current,
      currentDocId: initialDocumentId,
    })

    const urlChanged = previousDocumentIdRef.current !== initialDocumentId
    previousDocumentIdRef.current = initialDocumentId

    if (!urlChanged) {
      logger.debug('URL unchanged, skipping sync')
      return
    }

    logger.debug('URL changed, syncing UI state to match URL...')

    // Read current state without subscribing (no re-renders when state changes)
    const store = useUIStore.getState()

    if (initialDocumentId) {
      // Document URL - open editor with this document and ensure sidebar open
      if (store.activeDocumentId !== initialDocumentId) {
        logger.debug('Setting active document:', initialDocumentId)
        store.setActiveDocument(initialDocumentId)
      }
      if (store.rightPanelState !== 'editor') {
        logger.debug('Setting panel state: editor')
        store.setRightPanelState('editor')
      }
      if (store.rightPanelCollapsed) {
        logger.debug('Expanding right panel')
        store.setRightPanelCollapsed(false)
      }
    } else {
      // Tree URL - show tree view
      if (store.activeDocumentId !== null) {
        logger.debug('Clearing active document')
        store.setActiveDocument(null)
      }
      if (store.rightPanelState !== 'documents') {
        logger.debug('Setting panel state: documents')
        store.setRightPanelState('documents')
      }
    }
  }, [initialDocumentId])

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
    const store = useUIStore.getState()
    if (existsInTree && store.activeDocumentId !== initialDocumentId) {
      logger.debug('Tree loaded, syncing active document to URL:', initialDocumentId)
      store.setActiveDocument(initialDocumentId)
    }
  }, [documentsCount, documents, initialDocumentId])

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
            {/* Chat list / navigation lives entirely in the left panel */}
            <ChatListPanel projectId={projectId} />
          </CollapsiblePanel>
        }
        center={<ActiveChatView />}
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
