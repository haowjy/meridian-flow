import { useState } from 'react'
import { Plus, Sparkles, Loader2 } from 'lucide-react'
import { useSkillStore } from '@/core/stores/useSkillStore'
import { useSkillsForProject } from '../hooks/useSkillsForProject'
import { Button } from '@/shared/components/ui/button'
import { SkillList } from './SkillList'
import { SkillDialog } from './SkillDialog'
import { DeleteSkillDialog } from './DeleteSkillDialog'
import { getErrorMessage } from '@/core/lib/errors'
import { api } from '@/core/lib/api'
import type { Skill, SkillWithContent } from '../types/skill'

interface SkillListPanelProps {
  projectId: string
}

/**
 * Skills panel for viewing and managing project skills.
 * Can be used in a sidebar or as a standalone panel.
 */
export function SkillListPanel({ projectId }: SkillListPanelProps) {
  const {
    skills,
    status,
    isLoading,
    selectedSkillId,
    setSelectedSkillId,
  } = useSkillsForProject(projectId)

  const deleteSkill = useSkillStore((s) => s.deleteSkill)

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [skillToEdit, setSkillToEdit] = useState<SkillWithContent | null>(null)
  const [isLoadingSkill, setIsLoadingSkill] = useState(false)
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleSelectSkill = (skillId: string) => {
    setSelectedSkillId(skillId === selectedSkillId ? null : skillId)
  }

  const handleEditSkill = async (skill: Skill) => {
    setIsLoadingSkill(true)
    try {
      const fullSkill = await api.skills.get(projectId, skill.id)
      setSkillToEdit(fullSkill)
    } catch (error) {
      console.error('Failed to load skill:', getErrorMessage(error))
    } finally {
      setIsLoadingSkill(false)
    }
  }

  const handleDeleteClick = (skill: Skill) => {
    setSkillToDelete(skill)
  }

  const handleDeleteConfirm = async () => {
    if (!skillToDelete) return

    setIsDeleting(true)
    try {
      await deleteSkill(projectId, skillToDelete.id)
      setSkillToDelete(null)
    } catch (error) {
      console.error('Failed to delete skill:', getErrorMessage(error))
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="relative flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-amber-500" />
          <h2 className="font-medium text-sm">Skills</h2>
          {skills.length > 0 && (
            <span className="text-xs text-muted-foreground">({skills.length})</span>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="size-7 p-0"
          onClick={() => setCreateDialogOpen(true)}
          disabled={isLoading}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-2">
        {status === 'loading' && (
          <div className="px-3 py-8 text-center text-muted-foreground text-sm">
            Loading skills...
          </div>
        )}

        {status === 'error' && (
          <div className="px-3 py-8 text-center text-destructive text-sm">
            Failed to load skills
          </div>
        )}

        {status === 'success' && (
          <SkillList
            skills={skills}
            selectedSkillId={selectedSkillId}
            onSelectSkill={handleSelectSkill}
            onEditSkill={handleEditSkill}
            onDeleteSkill={handleDeleteClick}
          />
        )}
      </div>

      {/* Loading overlay for skill fetch */}
      {isLoadingSkill && (
        <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Dialogs */}
      <SkillDialog
        projectId={projectId}
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      <SkillDialog
        projectId={projectId}
        skill={skillToEdit}
        open={skillToEdit !== null}
        onOpenChange={(open) => {
          if (!open) setSkillToEdit(null)
        }}
      />

      <DeleteSkillDialog
        skill={skillToDelete}
        open={skillToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSkillToDelete(null)
        }}
        onConfirm={handleDeleteConfirm}
        isDeleting={isDeleting}
      />
    </div>
  )
}
