import { cn } from '@/lib/utils'
import type { Skill } from '../types/skill'
import { Zap, Lock, MoreVertical, Trash2, Pencil } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip'
import { Button } from '@/shared/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'

interface SkillListItemProps {
  skill: Skill
  isSelected: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
}

export function SkillListItem({ skill, isSelected, onSelect, onEdit, onDelete }: SkillListItemProps) {
  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer transition-colors',
        'hover:bg-primary/50',
        isSelected && 'bg-primary'
      )}
      onClick={onSelect}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium truncate">{skill.name}</span>
          {skill.disableModelInvocation && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="size-3 text-muted-foreground flex-shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Manual invocation only</TooltipContent>
            </Tooltip>
          )}
          {skill.userInvocable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Zap className="size-3 text-amber-500 flex-shrink-0" />
              </TooltipTrigger>
              <TooltipContent>User invocable</TooltipContent>
            </Tooltip>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{skill.description}</p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(); }}>
            <Pencil className="size-4 mr-2" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            <Trash2 className="size-4 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
