import { useState, FormEvent } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Label } from '@/shared/components/ui/label'
import { Input } from '@/shared/components/ui/input'
import type { Folder } from '@/features/folders/types/folder'

interface CreateDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (name: string, folderId?: string) => Promise<void>
  folders: Folder[]
}

/**
 * Modal for creating new documents.
 * Validates document name (required, max 100 chars).
 * Allows optional folder selection (defaults to root).
 */
export function CreateDocumentDialog({
  open,
  onOpenChange,
  onCreate,
  folders,
}: CreateDocumentDialogProps) {
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    // Validation
    if (!name.trim()) {
      setError('Document name is required')
      return
    }

    if (name.length > 100) {
      setError('Document name must be 100 characters or less')
      return
    }

    setIsSubmitting(true)

    try {
      await onCreate(name.trim(), folderId || undefined)

      // Success: reset form and close
      setName('')
      setFolderId('')
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create document')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!isSubmitting) {
      setError(null)
      setName('')
      setFolderId('')
      onOpenChange(newOpen)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create New Document</DialogTitle>
            <DialogDescription>
              Add a new document to your project. Choose a folder or leave it at the root.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Document Name */}
            <div className="space-y-2">
              <Label htmlFor="document-name">Document Name</Label>
              <Input
                id="document-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Chapter 1"
                maxLength={100}
                required
                autoFocus
                disabled={isSubmitting}
              />
            </div>

            {/* Folder Selection (Optional) */}
            {folders.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="folder-select">Folder (optional)</Label>
                <select
                  id="folder-select"
                  value={folderId}
                  onChange={(e) => setFolderId(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isSubmitting}
                >
                  <option value="">Root (no folder)</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Error Message */}
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create Document'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
