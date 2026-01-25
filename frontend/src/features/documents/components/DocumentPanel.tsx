import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FileText, Sparkles, Settings } from 'lucide-react'
import { useUIStore } from '@/core/stores/useUIStore'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { DocumentTreeContainer } from './DocumentTreeContainer'
import { EditorPanel } from './EditorPanel'
import { DocumentHeaderBar } from './DocumentHeaderBar'
import { SkillListPanel } from '@/features/skills'
import { ProjectSettingsDialog } from '@/features/projects/components/ProjectSettingsDialog'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'
import { MobileNavButton } from '@/shared/components/layout/MobileNavButton'
import { CompactBreadcrumb } from '@/shared/components/ui/CompactBreadcrumb'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/lib/utils'

export type PanelTab = 'documents' | 'skills'

interface DocumentPanelProps {
  projectId: string
  projectSlug: string
  projectName: string | null
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}

function TabButton({ active, onClick, icon, label }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * View switcher for document experience.
 * Shows either document tree (for browsing), skills panel, or editor (for editing).
 * View determined by UIStore.rightPanelState and activeTab.
 */
export function DocumentPanel({ projectId, projectSlug, projectName }: DocumentPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('documents')
  const { rightPanelState, activeDocumentId } = useUIStore(useShallow((s) => ({
    rightPanelState: s.rightPanelState,
    activeDocumentId: s.activeDocumentId,
  })))

  // Project settings dialog state (shared for skills view)
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false)
  const { currentProject, updateProject } = useProjectStore(
    useShallow((s) => ({
      currentProject: s.currentProject,
      updateProject: s.updateProject,
    }))
  )
  const project = currentProject()

  const handleSettingsSubmit = async (systemPrompt: string | null) => {
    if (!project) return
    await updateProject(project.id, { systemPrompt })
  }

  // Editor view: Show editor with active document
  if (rightPanelState === 'editor' && activeDocumentId) {
    return <EditorPanel documentId={activeDocumentId} />
  }

  // Skills view: Show skills panel with shared header and tab bar
  if (activeTab === 'skills') {
    return (
      <div className="flex h-full flex-col">
        {/* Sticky Header */}
        <div className="shrink-0 bg-background">
          <DocumentHeaderBar
            leading={
              <MobileNavButton
                icon="thread"
                onClick={() => useUIStore.getState().setMobileActivePanel('activeThread')}
              />
            }
            title={<CompactBreadcrumb segments={[{ label: projectName ?? 'Project', title: projectName ?? undefined }]} singleSegmentVariant="nonLast" />}
            ariaLabel="Skills panel header"
            showDivider={false}
            trailing={
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setIsSettingsDialogOpen(true)}
                  aria-label="Project settings"
                >
                  <Settings />
                </Button>
                <SidebarToggle side="right" />
              </>
            }
          />
        </div>

        {/* Tab Bar */}
        <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 bg-background border-b">
          <TabButton
            active={false}
            onClick={() => setActiveTab('documents')}
            icon={<FileText className="size-3.5" />}
            label="Docs"
          />
          <TabButton
            active={true}
            onClick={() => setActiveTab('skills')}
            icon={<Sparkles className="size-3.5" />}
            label="Skills"
          />
        </div>

        {/* Skills Content */}
        <div className="flex-1 min-h-0">
          <SkillListPanel projectId={projectId} />
        </div>

        <ProjectSettingsDialog
          project={project}
          open={isSettingsDialogOpen}
          onOpenChange={setIsSettingsDialogOpen}
          onSubmit={handleSettingsSubmit}
        />
      </div>
    )
  }

  // Default view: Show document tree
  return (
    <DocumentTreeContainer
      projectId={projectId}
      projectSlug={projectSlug}
      projectName={projectName}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  )
}
