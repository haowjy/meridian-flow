"use client"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'

interface DebugInfoDialogProps {
  isOpen: boolean
  onClose: () => void
  title: string
  data: Record<string, unknown>
}

/**
 * Debug information dialog.
 *
 * Displays metadata in a simple key-value format.
 * Only shown when NEXT_PUBLIC_DEV_TOOLS=1.
 */
export function DebugInfoDialog({ isOpen, onClose, title, data }: DebugInfoDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {Object.entries(data).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <span className="font-medium text-muted-foreground min-w-[140px]">{key}:</span>
              <span className="font-mono text-xs break-all">
                {value === null || value === undefined
                  ? 'null'
                  : typeof value === 'object'
                    ? JSON.stringify(value, null, 2)
                    : String(value)}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
