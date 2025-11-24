import { Button } from '@/shared/components/ui/button'
import { DialogFooter } from '@/shared/components/ui/dialog'
import { Label } from '@/shared/components/ui/label'
import { ImportResponse } from '@/core/lib/api'

interface ImportResultsProps {
  results: ImportResponse
  onClose: () => void
  onImportMore: () => void
}

export function ImportResults({
  results,
  onClose,
  onImportMore,
}: ImportResultsProps) {
  const { summary, documents, errors } = results

  return (
    <>
      <div className="grid gap-4 py-4">
        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-2 text-center">
          <StatBadge
            label="Created"
            value={summary.created}
            variant="success"
          />
          <StatBadge
            label="Updated"
            value={summary.updated}
            variant="default"
          />
          <StatBadge
            label="Skipped"
            value={summary.skipped}
            variant="muted"
          />
          <StatBadge label="Failed" value={summary.failed} variant="error" />
        </div>

        {/* Success List */}
        {documents.length > 0 && (
          <div className="space-y-2">
            <Label>Imported Documents</Label>
            <div className="max-h-48 overflow-y-auto rounded border border-border bg-muted/20 p-3 space-y-1">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="truncate font-mono text-xs">{doc.path}</span>
                  <span
                    className={
                      doc.action === 'created'
                        ? 'text-primary'
                        : 'text-muted-foreground'
                    }
                  >
                    {doc.action}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error List */}
        {errors.length > 0 && (
          <div className="space-y-2">
            <Label className="text-destructive">Failed Imports</Label>
            <div className="max-h-32 overflow-y-auto rounded border border-destructive/30 bg-destructive/5 p-3 space-y-2">
              {errors.map((err, idx) => (
                <div key={idx} className="text-sm space-y-0.5">
                  <div className="font-medium text-destructive">{err.file}</div>
                  <div className="text-xs text-muted-foreground">
                    {err.error}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onImportMore}>
          Import More
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  )
}

// Helper component for stat badges
function StatBadge({
  label,
  value,
  variant,
}: {
  label: string
  value: number
  variant: 'success' | 'error' | 'muted' | 'default'
}) {
  const colorClass =
    variant === 'success'
      ? 'text-primary'
      : variant === 'error'
        ? 'text-destructive'
        : variant === 'muted'
          ? 'text-muted-foreground'
          : 'text-foreground'

  return (
    <div>
      <div className={`text-2xl font-semibold ${colorClass}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}
