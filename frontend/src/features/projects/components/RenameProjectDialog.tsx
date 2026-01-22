import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Input } from '@/shared/components/ui/input'
import { Button } from '@/shared/components/ui/button'
import { Field } from '@/shared/components/Field'
import { Loader2 } from 'lucide-react'
import { Project } from '../types/project'

interface RenameProjectDialogProps {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<void>
}

export function RenameProjectDialog({
  project,
  open,
  onOpenChange,
  onSubmit,
}: RenameProjectDialogProps) {
  const [name, setName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form when project changes
  useEffect(() => {
    if (project) {
      setName(project.name)
      setError(null)
    }
  }, [project])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Validation
    if (!name.trim()) {
      setError('Project name is required')
      return
    }

    if (name.length > 255) {
      setError('Project name must be 255 characters or less')
      return
    }

    // No change
    if (name.trim() === project?.name) {
      onOpenChange(false)
      return
    }

    setIsSubmitting(true)
    try {
      await onSubmit(name.trim())
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename project')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!isSubmitting) {
      onOpenChange(newOpen)
      if (!newOpen) {
        setName('')
        setError(null)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename Project</DialogTitle>
          <DialogDescription>
            Enter a new name for this project.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-3 py-2">
            <Field
              label="Project Name"
              id="rename-name"
              error={error || undefined}
              required
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Novel"
                disabled={isSubmitting}
                autoFocus
              />
            </Field>
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
              {isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
