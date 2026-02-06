import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger as RadixHoverCardTrigger,
  HoverCardArrow,
} from "@/shared/components/ui/hover-card";

// Re-export for use with triggerWrapper pattern
export { RadixHoverCardTrigger as HoverCardTrigger };
import { TreeItemInfoContent } from "./TreeItemInfoContent";
import type { Folder } from "@/features/folders/types/folder";
import type { Document } from "@/features/documents/types/document";
import type { Skill } from "@/features/skills/types/skill";
import type { ReactElement } from "react";

interface FolderHoverCardProps {
  children: ReactElement;
  item: Folder;
  type: "folder";
  documentCount?: number;
  folderCount?: number;
}

interface DocumentHoverCardProps {
  children: ReactElement;
  item: Document;
  type: "document";
}

interface SkillHoverCardProps {
  children: ReactElement;
  item: Skill;
  type: "skill";
}

type TreeItemInfoHoverCardProps =
  | FolderHoverCardProps
  | DocumentHoverCardProps
  | SkillHoverCardProps;

/**
 * HoverCard wrapper for hover-triggered info display (desktop).
 * Shows TreeItemInfoContent on hover with a slight delay.
 */
export function TreeItemInfoHoverCard(props: TreeItemInfoHoverCardProps) {
  const { children, type } = props;

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      {/* Children should contain a HoverCardTrigger via the triggerWrapper pattern */}
      {children}
      <HoverCardContent
        side="left"
        align="start"
        sideOffset={12}
        className="bg-popover w-64 border-0 p-3 shadow-md"
      >
        <HoverCardArrow className="fill-popover stroke-none" />
        {type === "folder" && (
          <TreeItemInfoContent
            variant="hover"
            type="folder"
            item={props.item}
            documentCount={props.documentCount}
            folderCount={props.folderCount}
          />
        )}
        {type === "document" && (
          <TreeItemInfoContent
            variant="hover"
            type="document"
            item={props.item}
          />
        )}
        {type === "skill" && (
          <TreeItemInfoContent variant="hover" type="skill" item={props.item} />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
