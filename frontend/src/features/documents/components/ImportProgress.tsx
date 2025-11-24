import { Loader2 } from 'lucide-react'

export function ImportProgress() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8">
      <Loader2 className="size-8 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">Importing documents...</p>
    </div>
  )
}
