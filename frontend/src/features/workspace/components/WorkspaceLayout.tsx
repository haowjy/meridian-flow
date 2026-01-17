import { useEffect, useState, useRef, useMemo } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { useLayoutStrategy } from '@/core/hooks/useLayoutStrategy'
import { useUIStore, selectEffectiveRightCollapsed } from '@/core/stores/useUIStore'
import { DocumentPanel } from '@/features/documents/components/DocumentPanel'
import { ThreadListPanel } from '@/features/threads/components/ThreadListPanel'
import { ActiveThreadView } from '@/features/threads/components/ActiveThreadView'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { api } from '@/core/lib/api'
import { makeLogger } from '@/core/lib/logger'
import type { PanelDefinitions } from '@/shared/components/layout/types'

const logger = makeLogger('workspace-layout')

interface WorkspaceLayoutProps {
  /** Project identifier - can be UUID or slug (backend resolver handles both) */
  projectIdentifier: string
  /** Document slug from URL - resolved to ID once tree is loaded */
  initialDocumentSlug?: string
}

export default function WorkspaceLayout({ projectIdentifier, initialDocumentSlug }: WorkspaceLayoutProps) {
  const navigate = useNavigate()
  // Resolved project ID (UUID) and slug - set once project is fetched/found
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectSlug, setProjectSlug] = useState<string | null>(null)
  const [projectName, setProjectName] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const previousDocumentIdRef = useRef<string | undefined>(undefined)
  const previousProjectIdRef = useRef<string | undefined>(undefined)
  const isFirstMountRef = useRef(true)

  // Get layout strategy based on viewport (ThreePanelLayout for desktop, MobileTabLayout for mobile)
  const LayoutStrategy = useLayoutStrategy()

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

  const location = useLocation()

  // Derive the document slug from the current URL path.
  // This is intentionally decoupled from route components so that:
  // - Direct URL navigation (deep links)
  // - Browser back/forward
  // still drive the editor/tree state correctly even if the document route
  // component itself does not render (e.g., due to nesting or Outlet usage).
  //
  // Path-based slugs: captures ALL segments after /documents/ and joins them.
  // Example: /documents/characters/heroes/aria → "characters/heroes/aria"
  const urlDocumentSlug = useMemo(() => {
    const segments = location.pathname.split('/').filter(Boolean)
    const documentsIndex = segments.indexOf('documents')
    if (documentsIndex === -1) return undefined
    // Get ALL segments after 'documents', join with '/' for path-based slugs
    const pathSegments = segments.slice(documentsIndex + 1)
    return pathSegments.length > 0 ? pathSegments.join('/') : undefined
  }, [location.pathname])

  // Prefer explicit prop when provided (e.g., from a dedicated document route),
  // but fall back to URL parsing so that deep links and browser navigation
  // still work correctly.
  const effectiveDocumentSlug = initialDocumentSlug ?? urlDocumentSlug

  // Resolve document slug to document ID using the tree store
  // Returns the UUID if found by slug (or ID for backwards compat), undefined otherwise
  const effectiveDocumentId = useMemo(() => {
    if (!effectiveDocumentSlug) return undefined
    // Try to find document by slug first, then by ID (for backwards compatibility)
    const doc = documents.find((d) => d.slug === effectiveDocumentSlug || d.id === effectiveDocumentSlug)
    return doc?.id
  }, [effectiveDocumentSlug, documents])

  // Resolve project identifier (UUID or slug) to actual project
  // Sets projectId state once resolved
  useEffect(() => {
    // Prevent duplicate work for the same identifier
    if (previousProjectIdRef.current === projectIdentifier) return
    previousProjectIdRef.current = projectIdentifier

    let ignore = false
    const abortController = new AbortController()

    async function resolveProject() {
      // Try to find the project in the existing list first (by ID or slug)
      const existing = projects.find((p) => p.id === projectIdentifier || p.slug === projectIdentifier)

      let project = existing
      if (!project) {
        try {
          // API accepts both UUID and slug (backend resolver handles it)
          project = await api.projects.get(projectIdentifier, { signal: abortController.signal })
        } catch (error) {
          // Non-fatal for the layout; header will fallback until projects page refreshes.
          // Errors are surfaced elsewhere when listing projects; we still log for debuggability.
          if ((error as Error)?.name === 'AbortError') {
            logger.debug('Project fetch aborted in workspace layout (expected during unmount/StrictMode)')
          } else {
            logger.warn('Failed to resolve project in workspace layout', error)
            navigate({ to: '/projects' })
          }
        }
      }

      if (!ignore && project) {
        // Set resolved project ID and slug for use in child components
        setProjectId(project.id)
        setProjectSlug(project.slug)
        setProjectName(project.name)
        // Switch context only if different to avoid unnecessary editor cache clears
        if (currentProjectId !== project.id) {
          setCurrentProject(project)
        }
      }
    }

    resolveProject()
    return () => {
      ignore = true
      abortController.abort()
      // Reset ref so StrictMode re-mount can retry the API call
      previousProjectIdRef.current = undefined
    }
    // Intentionally depend only on projectIdentifier and stable setters to avoid constant re-runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdentifier])

  // Reset UI state when project changes to prevent context leakage
  useEffect(() => {
    const store = useUIStore.getState()
    store.setActiveDocument(null)
    store.setRightPanelState('documents')
    // Reset panel ready state for new project - panels will collapse until new data loads
    store.setLeftPanelReady(false)
    store.setRightPanelReady(false)
    // Note: Do NOT reset userOverride - user's collapse/expand preference should persist across projects
    previousDocumentIdRef.current = undefined // Reset ref so next URL is treated as changed
  }, [projectId])

  // Sync URL document ID to UI state (for direct URL navigation, bookmarks, browser back/forward)
  // Uses getState() to read current values without subscribing (prevents unnecessary re-runs)
  // Effect only runs when document URL param changes, not when UI state changes
  // This allows future thread effects to run independently without interfering
  useEffect(() => {
    logger.debug('URL sync effect triggered', {
      previousDocId: previousDocumentIdRef.current,
      currentDocId: effectiveDocumentId,
      isFirstMount: isFirstMountRef.current,
    })

    const urlChanged = previousDocumentIdRef.current !== effectiveDocumentId
    const isFirstMount = isFirstMountRef.current

    previousDocumentIdRef.current = effectiveDocumentId
    isFirstMountRef.current = false

    // Skip only if NOT first mount AND URL didn't change
    if (!isFirstMount && !urlChanged) {
      logger.debug('URL unchanged (not first mount), skipping sync')
      return
    }

    logger.debug('URL changed, syncing UI state to match URL...')

    // Read current state without subscribing (no re-renders when state changes)
    const store = useUIStore.getState()

    if (effectiveDocumentId) {
      // Document URL - open editor with this document and ensure sidebar open
      if (store.activeDocumentId !== effectiveDocumentId) {
        logger.debug('Setting active document:', effectiveDocumentId)
        store.setActiveDocument(effectiveDocumentId)
      }
      if (store.rightPanelState !== 'editor') {
        logger.debug('Setting panel state: editor')
        store.setRightPanelState('editor')
      }
      // Check effective collapsed state (considers ready state + user override)
      if (selectEffectiveRightCollapsed(store)) {
        logger.debug('Expanding right panel')
        store.setRightPanelCollapsed(false)
      }
      // Mobile: On first mount, default to document tab for document deep-links.
      // After that, keep the user's current tab even if the document changes.
      if (isFirstMount && store.mobileActivePanel !== 'document') {
        logger.debug('Setting mobile panel: document (first mount)')
        store.setMobileActivePanel('document')
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
  }, [effectiveDocumentId])

  // For deep links: load the tree once in the background if empty
  // Uses effectiveDocumentSlug (not effectiveDocumentId) since we need tree loaded to resolve slug → ID
  useEffect(() => {
    if (!effectiveDocumentSlug) return
    if (projectId === null) return // Wait for project to be resolved
    if (documentsCount !== 0 || isTreeLoading) return

    const abortController = new AbortController()
    loadTree(projectId, abortController.signal)
    return () => abortController.abort()
  }, [projectId, effectiveDocumentSlug, documentsCount, isTreeLoading, loadTree])

  // After the tree loads, ensure the active document selection reflects the tree entry
  useEffect(() => {
    if (!effectiveDocumentId) return
    if (documentsCount === 0) return

    const existsInTree = documents.some((d) => d.id === effectiveDocumentId)
    const store = useUIStore.getState()
    if (existsInTree && store.activeDocumentId !== effectiveDocumentId) {
      logger.debug('Tree loaded, syncing active document to URL:', effectiveDocumentId)
      store.setActiveDocument(effectiveDocumentId)
    }
  }, [documentsCount, documents, effectiveDocumentId])

  // Wait for mount and project resolution before rendering workspace
  if (!mounted || projectId === null || projectSlug === null) {
    return <div className="h-dvh w-full bg-background" />
  }

  // Define panel content (what to show) - layout strategy decides how to arrange them
  const panels: PanelDefinitions = {
    threadList: <ThreadListPanel projectId={projectId} />,
    activeThread: <ActiveThreadView projectId={projectId} />,
    documentPanel: (
      <DocumentPanel
        projectId={projectId}
        projectSlug={projectSlug}
        projectName={projectName}
      />
    ),
  }

  return (
    <div className="h-dvh w-full overflow-hidden">
      <LayoutStrategy panels={panels} />
    </div>
  )
}
