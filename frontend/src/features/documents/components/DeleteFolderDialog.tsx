'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import type { Folder } from '@/features/folders/types/folder'

interface DeleteFolderDialogProps {
  folder: Folder | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isDeleting?: boolean
}

/**
 * Confirmation dialog for deleting a folder and all its contents.
 *
 * Warns the user that deletion includes all documents and subfolders.
 */
export function DeleteFolderDialog({
  folder,
  open,
  onOpenChange,
  onConfirm,
  isDeleting,
}: DeleteFolderDialogProps) {
  const handleConfirm = () => {
    onConfirm()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Folder</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete &quot;{folder?.name || 'Untitled Folder'}&quot;
            and all its contents? This will permanently delete all documents and
            subfolders inside. This action cannot be undone.
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
