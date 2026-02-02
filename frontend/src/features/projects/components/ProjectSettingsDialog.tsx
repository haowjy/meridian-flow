import { useState, useEffect } from 'react'
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
import { Textarea } from '@/shared/components/ui/textarea'
import { Loader2 } from 'lucide-react'
import { Project } from '../types/project'

interface ProjectSettingsDialogProps {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (systemPrompt: string | null) => Promise<void>
}

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onSubmit,
}: ProjectSettingsDialogProps) {
  const [instructions, setInstructions] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form when project changes
  useEffect(() => {
    if (project) {
      setInstructions(project.systemPrompt ?? '')
      setError(null)
    }
  }, [project])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmed = instructions.trim()
    const currentValue = project?.systemPrompt?.trim() ?? ''

    // No change
    if (trimmed === currentValue) {
      onOpenChange(false)
      return
    }

    setIsSubmitting(true)
    try {
      // Send null if empty, otherwise send the trimmed value
      await onSubmit(trimmed || null)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project settings')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!isSubmitting) {
      onOpenChange(newOpen)
      if (!newOpen) {
        setInstructions('')
        setError(null)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
          <DialogDescription>
            Customize how AI interacts with this project.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-3 py-2">
            <div className="grid gap-2">
              <Label htmlFor="instructions">Instructions</Label>
              <Textarea
                id="instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Give the AI context about this project..."
                disabled={isSubmitting}
                className="resize-none min-h-[120px]"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                These instructions will be included in every AI conversation for this project.
              </p>
            </div>
            {error && (
              <p className="text-sm text-error">{error}</p>
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
              {isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
