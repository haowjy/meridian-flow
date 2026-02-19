import { TreeItemInfoHeader } from "./TreeItemInfoHeader";
import { TreeItemInfoMeta } from "./TreeItemInfoMeta";
import { formatRelativeTime } from "@/core/lib/formatters";
import type { Folder } from "@/features/folders/types/folder";
import type { Document } from "@/features/documents/types/document";
import type { Skill } from "@/features/skills/types/skill";
import { FileText, Folder as FolderIcon, Sparkles } from "lucide-react";

/** Max characters for skill description in hover card before truncating */
const SKILL_DESCRIPTION_MAX_CHARS = 100;

// TODO: Future enhancements for TreeItemInfoContent:
// - TreeItemInfoSummary: AI-generated summary (read-only display)
// - TreeItemInfoTags: Tag display (read-only chips)
// - Edit actions: Single "Edit" button -> popup with all editable fields
//   (tags, summary, etc.) rather than individual edit menu items

interface FolderContentProps {
  type: "folder";
  item: Folder;
  documentCount?: number;
  folderCount?: number;
}

interface DocumentContentProps {
  type: "document";
  item: Document;
}

interface SkillContentProps {
  type: "skill";
  item: Skill;
}

type TreeItemInfoContentProps = (
  | FolderContentProps
  | DocumentContentProps
  | SkillContentProps
) & {
  /**
   * - `hover`: compact, preview-like (no filename; avoids covering list scanning).
   * - `dialog`: full details, including name header.
   */
  variant?: "hover" | "dialog";
};

/**
 * Shared content component used by both HoverCard and Dialog.
 * Composed of sections for extensibility.
 */
export function TreeItemInfoContent(props: TreeItemInfoContentProps) {
  const variant = props.variant ?? "hover";

  if (variant === "hover") {
    // Skill hover has custom rendering (description + modified time)
    if (props.type === "skill") {
      const { item } = props;
      const description =
        item.description.length > SKILL_DESCRIPTION_MAX_CHARS
          ? `${item.description.slice(0, SKILL_DESCRIPTION_MAX_CHARS).trim()}…`
          : item.description;

      return (
        <div className="space-y-2">
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Sparkles className="size-3.5 flex-shrink-0 text-amber-500" />
            <span>/{item.name}</span>
          </div>
          {description && (
            <div className="text-foreground text-sm">{description}</div>
          )}
          {item.updatedAt && (
            <div className="text-muted-foreground text-xs">
              Modified {formatRelativeTime(item.updatedAt)}
            </div>
          )}
        </div>
      );
    }

    const Icon = props.type === "folder" ? FolderIcon : FileText;
    const label = props.type === "folder" ? "Folder" : "Document";

    return (
      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Icon className="size-3.5 flex-shrink-0" />
          <span>{label}</span>
        </div>
        {props.type === "folder" ? (
          <TreeItemInfoMeta
            type="folder"
            item={props.item}
            documentCount={props.documentCount}
            folderCount={props.folderCount}
          />
        ) : (
          <TreeItemInfoMeta type="document" item={props.item} />
        )}
      </div>
    );
  }

  if (props.type === "folder") {
    return (
      <div className="space-y-3">
        <TreeItemInfoHeader name={props.item.name} type="folder" />
        <TreeItemInfoMeta
          type="folder"
          item={props.item}
          documentCount={props.documentCount}
          folderCount={props.folderCount}
        />
        {/* Future: <TreeItemInfoSummary /> */}
        {/* Future: <TreeItemInfoTags /> */}
      </div>
    );
  }

  if (props.type === "document") {
    return (
      <div className="space-y-3">
        <TreeItemInfoHeader name={props.item.filename} type="document" />
        <TreeItemInfoMeta type="document" item={props.item} />
        {/* Future: <TreeItemInfoSummary /> */}
        {/* Future: <TreeItemInfoTags /> */}
      </div>
    );
  }

  // Skill dialog variant: not yet implemented.
  // When skills need a details dialog, add TreeItemInfoHeader + meta here.
  return null;
}
