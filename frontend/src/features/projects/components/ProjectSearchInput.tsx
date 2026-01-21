import { Search, X } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { useUIStore } from '@/core/stores/useUIStore'
import { useCallback } from 'react'

interface ProjectSearchInputProps {
  autoFocus?: boolean
  onRequestClose?: () => void
}

export function ProjectSearchInput({ autoFocus, onRequestClose }: ProjectSearchInputProps) {
  const query = useUIStore((state) => state.projectSearchQuery)
  const setQuery = useUIStore((state) => state.setProjectSearchQuery)

  const handleClear = useCallback(() => {
    setQuery('')
  }, [setQuery])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // On the projects page, search is a transient UI affordance: Esc closes it.
      // This avoids trapping the user in "search mode", especially on mobile.
      if (onRequestClose) {
        onRequestClose()
        return
      }
      handleClear()
    }
  }, [handleClear, onRequestClose])

  return (
    <div className="relative w-full max-w-md">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
      <Input
        autoFocus={autoFocus}
        type="text"
        placeholder="Search projects..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="pl-9 pr-9"
      />
      {query && (
        <button
          onClick={handleClear}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted transition-colors"
          aria-label="Clear search"
        >
          <X className="size-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}
