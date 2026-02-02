import { DeleteConfirmationDialog } from '@/shared/components/ui/delete-confirmation-dialog'
import type { Thread } from '@/features/threads/types'

interface DeleteThreadDialogProps {
  thread: Thread | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isDeleting?: boolean
}

/**
 * Confirmation dialog for deleting a thread.
 *
 * Shows the thread title and warns the user that deletion cannot be undone.
 */
export function DeleteThreadDialog({
  thread,
  open,
  onOpenChange,
  onConfirm,
  isDeleting,
}: DeleteThreadDialogProps) {
  return (
    <DeleteConfirmationDialog
      title="Delete Thread"
      itemName={thread?.title || 'Untitled Thread'}
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      isDeleting={isDeleting}
    />
  )
}
