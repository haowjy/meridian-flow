import { ChevronDown, Check } from 'lucide-react'
import { useUIStore, type ProjectSortOrder } from '@/core/stores/useUIStore'
import { Button } from '@/shared/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'

const SORT_OPTIONS: { value: ProjectSortOrder; label: string }[] = [
  { value: 'updated', label: 'Last updated' },
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'created-newest', label: 'Newest created' },
  { value: 'created-oldest', label: 'Oldest created' },
]

export function ProjectSortDropdown() {
  const sortOrder = useUIStore((state) => state.projectSortOrder)
  const setSortOrder = useUIStore((state) => state.setProjectSortOrder)

  const currentOption = SORT_OPTIONS.find((opt) => opt.value === sortOrder) ?? SORT_OPTIONS[0]!

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <span className="type-label">Sort: {currentOption.label}</span>
          <ChevronDown className="size-4.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        {SORT_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => setSortOrder(option.value)}
            className="flex items-center justify-between"
          >
            <span>{option.label}</span>
            {sortOrder === option.value && (
              <Check className="size-4.5 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
