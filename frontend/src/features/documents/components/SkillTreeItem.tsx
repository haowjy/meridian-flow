import { memo } from "react";
import { Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TreeItemWithContextMenu,
  type TreeMenuItemConfig,
} from "@/shared/components/TreeItemWithContextMenu";
import {
  TreeItemInfoHoverCard,
  HoverCardTrigger,
} from "./tree-item-info/TreeItemInfoHoverCard";
import type { Skill } from "@/features/skills/types/skill";

interface SkillTreeItemProps {
  skill: Skill;
  isActive: boolean;
  onClick: (skillId: string) => void;
  onDelete: (skillId: string, skill: Skill) => void;
}

/**
 * Tree item for displaying a skill (leaf node).
 * Memoized for performance - only re-renders when props change.
 * Click opens skill in editor, context menu provides actions.
 */
export const SkillTreeItem = memo(function SkillTreeItem({
  skill,
  isActive,
  onClick,
  onDelete,
}: SkillTreeItemProps) {
  const contextMenuItems: TreeMenuItemConfig[] = [
    {
      id: "skill-delete",
      label: "Delete",
      icon: <Trash2 className="h-4 w-4" />,
      onSelect: () => onDelete(skill.id, skill),
      variant: "destructive" as const,
    },
  ];

  return (
    <TreeItemInfoHoverCard type="skill" item={skill}>
      <TreeItemWithContextMenu
        menuItems={contextMenuItems}
        triggerWrapper={(children) => (
          <HoverCardTrigger asChild>{children}</HoverCardTrigger>
        )}
      >
        <button
          onClick={() => onClick(skill.id)}
          className={cn(
            "flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-sm transition-colors",
            "hover:bg-hover",
            isActive && "bg-sidebar-accent/50 font-medium",
          )}
          aria-current={isActive ? "page" : undefined}
        >
          {/* Sparkles icon for skills */}
          <Sparkles className="size-4 shrink-0 text-amber-500 md:size-3.5" />

          {/* Skill display name (user-facing) */}
          <span className="min-w-0 flex-1 truncate">{skill.name}</span>
        </button>
      </TreeItemWithContextMenu>
    </TreeItemInfoHoverCard>
  );
});
