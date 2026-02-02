import { useState, ReactNode } from 'react'
import { ChevronLeft, Menu } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/shared/components/ui/button'
import { useUIStore } from '@/core/stores/useUIStore'
import { MobileMenuSheet } from '@/shared/components/layout/MobileMenuSheet'
import { DocumentTreeContainer } from './DocumentTreeContainer'
import { EditorPanel } from './EditorPanel'
import { SkillEditorPanel } from '@/features/skills/components/SkillEditorPanel'

interface MobileDocumentViewProps {
  projectId: string
  projectSlug: string
}

export function MobileDocumentView({ projectId, projectSlug }: MobileDocumentViewProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const navigate = useNavigate()

  const activeDocumentId = useUIStore((s) => s.activeDocumentId)
  const activeSkillId = useUIStore((s) => s.activeSkillId)

  // Derive view from store (no local state)
  const view: 'tree' | 'editor' = activeDocumentId || activeSkillId ? 'editor' : 'tree'

  const handleBackToTree = () => {
    // Clear active document/skill + navigate to tree route
    const store = useUIStore.getState()
    store.setActiveDocument(null)
    store.setActiveSkill(null)
    navigate({ to: '/projects/$slug/tree', params: { slug: projectSlug } })
  }

  // Mobile menu trigger button - passed to DocumentTreePanel
  // Uses same specs as MobileHeader hamburger: size="icon" with size-5 icon
  const mobileMenuTrigger: ReactNode = (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setMobileMenuOpen(true)}
      aria-label="Menu"
    >
      <Menu className="size-5" />
    </Button>
  )

  // Mobile back button - passed to EditorHeader/SkillEditorPanel
  const mobileBackButton: ReactNode = (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleBackToTree}
      aria-label="Back to document tree"
    >
      <ChevronLeft className="size-5" />
    </Button>
  )

  if (view === 'tree') {
    return (
      <>
        {/* Tree view - single header in DocumentTreePanel with hamburger */}
        <div className="h-full overflow-hidden">
          <DocumentTreeContainer
            projectId={projectId}
            projectSlug={projectSlug}
            mobileMenuTrigger={mobileMenuTrigger}
          />
        </div>

        <MobileMenuSheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} inWorkspace />
      </>
    )
  }

  // Editor view - single header in EditorHeader/SkillEditorPanel with back button
  return (
    <>
      <div className="h-full overflow-hidden flex flex-col">
        <div className="flex-1 overflow-hidden">
          {activeSkillId ? (
            <SkillEditorPanel
              skillId={activeSkillId}
              projectId={projectId}
              projectSlug={projectSlug}
              onBackToTree={handleBackToTree}
            />
          ) : activeDocumentId ? (
            <EditorPanel
              documentId={activeDocumentId}
              mobileBackButton={mobileBackButton}
            />
          ) : null}
        </div>
      </div>
    </>
  )
}
