import { DeleteConfirmationDialog } from '@/shared/components/ui/delete-confirmation-dialog'
import { Project } from '../types/project'

interface DeleteProjectDialogProps {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}

export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
  onConfirm,
}: DeleteProjectDialogProps) {
  return (
    <DeleteConfirmationDialog
      title="Delete Project"
      itemName={project?.name}
      warningText="All documents and folders in this project will be permanently deleted."
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  )
}
