import { useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/components/ui/alert-dialog'
import { Loader2 } from 'lucide-react'

interface DeleteConfirmationDialogProps {
  /** Dialog title (e.g., "Delete Project") */
  title: string
  /** Name of the item being deleted (displayed in bold) */
  itemName: string | undefined
  /** Additional warning text after the item name. Defaults to "This action cannot be undone." */
  warningText?: ReactNode
  /** Whether the dialog is open */
  open: boolean
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when delete is confirmed. Can be sync or async. */
  onConfirm: () => void | Promise<void>
  /**
   * External loading state (controlled mode).
   * If not provided, the dialog manages its own loading state (uncontrolled mode).
   */
  isDeleting?: boolean
}

/**
 * Reusable confirmation dialog for delete operations.
 *
 * Supports both controlled (isDeleting prop) and uncontrolled (internal state) modes:
 * - Controlled: Pass isDeleting prop when parent manages the loading state
 * - Uncontrolled: Omit isDeleting to let the dialog manage state automatically
 *
 * @example
 * // Uncontrolled mode (auto-manages loading for async onConfirm)
 * <DeleteConfirmationDialog
 *   title="Delete Project"
 *   itemName={project.name}
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   onConfirm={handleDelete}
 * />
 *
 * @example
 * // Controlled mode (parent manages loading)
 * <DeleteConfirmationDialog
 *   title="Delete Skill"
 *   itemName={skill.name}
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   onConfirm={handleDelete}
 *   isDeleting={isDeleting}
 * />
 */
export function DeleteConfirmationDialog({
  title,
  itemName,
  warningText = 'This action cannot be undone.',
  open,
  onOpenChange,
  onConfirm,
  isDeleting: externalIsDeleting,
}: DeleteConfirmationDialogProps) {
  const [internalIsDeleting, setInternalIsDeleting] = useState(false)

  // Use external state if provided (controlled), otherwise internal (uncontrolled)
  const isControlled = externalIsDeleting !== undefined
  const isDeleting = isControlled ? externalIsDeleting : internalIsDeleting

  const handleConfirm = async () => {
    if (!isControlled) {
      setInternalIsDeleting(true)
    }
    try {
      await onConfirm()
    } finally {
      if (!isControlled) {
        setInternalIsDeleting(false)
      }
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{itemName}</strong>?{' '}
            {warningText}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting && <Loader2 className="mr-2 size-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
