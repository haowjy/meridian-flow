import { ChevronDown } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { ThreadTitleMenu } from "./ThreadTitleMenu";

interface EditableThreadTitleProps {
  threadTitle: string | null;
  onEdit: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}

/**
 * Unified thread title + dropdown component.
 *
 * Design pattern inspired by Claude.ai chat headers:
 * - Connected buttons with thin divider (title rounded-l, chevron rounded-r)
 * - Layered hover states (subtle group hover + stronger individual hover)
 * - Click title → Trigger edit mode
 * - Click chevron → Open dropdown menu
 */
export function EditableThreadTitle({
  threadTitle,
  onEdit,
  onRename,
  onDelete,
}: EditableThreadTitleProps) {
  return (
    <div className="group flex min-w-0 items-center">
      {/* Title button - rounded left only */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="hover:bg-hover group-hover:bg-hover/50 flex h-8 min-w-0 items-center rounded-l px-1.5 text-left transition-colors"
        style={{ scrollMargin: 0 }}
      >
        <span className="text-foreground truncate text-sm leading-none font-medium">
          {threadTitle ?? "Untitled Thread"}
        </span>
      </button>

      {/* Thin divider */}
      {/* <div className="w-[1.5px] h-7 bg-border" /> */}

      {/* Chevron button - rounded right only */}
      {(onRename || onDelete) && (
        <ThreadTitleMenu
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="hover:bg-hover group-hover:bg-hover/50 h-8 w-8 shrink-0 rounded-l-none rounded-r"
              aria-label="Thread options"
            >
              <ChevronDown />
            </Button>
          }
          onRename={onRename}
          onDelete={onDelete}
          align="start"
        />
      )}
    </div>
  );
}
