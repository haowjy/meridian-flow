import { cn } from "@/lib/utils";
import type { Skill } from "../types/skill";
import { Zap, Lock, MoreVertical, Trash2, Pencil } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";

interface SkillListItemProps {
  skill: Skill;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function SkillListItem({
  skill,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
}: SkillListItemProps) {
  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 transition-colors",
        "hover:bg-primary/50",
        isSelected && "bg-primary",
      )}
      onClick={onSelect}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{skill.name}</span>
          {skill.disableModelInvocation && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="text-muted-foreground size-3 flex-shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Manual invocation only</TooltipContent>
            </Tooltip>
          )}
          {skill.userInvocable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Zap className="size-3 flex-shrink-0 text-amber-500" />
              </TooltipTrigger>
              <TooltipContent>User invocable</TooltipContent>
            </Tooltip>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {skill.description}
        </p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Pencil className="mr-2 size-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="mr-2 size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
