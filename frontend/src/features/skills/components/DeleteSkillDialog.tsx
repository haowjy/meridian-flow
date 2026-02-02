import { DeleteConfirmationDialog } from '@/shared/components/ui/delete-confirmation-dialog'
import type { Skill } from '../types/skill'

interface DeleteSkillDialogProps {
  skill: Skill | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isDeleting: boolean
}

export function DeleteSkillDialog({
  skill,
  open,
  onOpenChange,
  onConfirm,
  isDeleting,
}: DeleteSkillDialogProps) {
  return (
    <DeleteConfirmationDialog
      title="Delete Skill"
      itemName={skill?.name}
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      isDeleting={isDeleting}
    />
  )
}
