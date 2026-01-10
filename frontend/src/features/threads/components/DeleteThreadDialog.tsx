import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
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
  const handleConfirm = () => {
    onConfirm()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Thread</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete &quot;{thread?.title || 'Untitled Thread'}&quot;?
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
