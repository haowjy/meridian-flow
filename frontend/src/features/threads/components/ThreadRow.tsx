import { useRef, useState } from "react";
import {
  Bot,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/shared/components/ui/button";
import type { Thread } from "@/features/threads/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/components/ui/context-menu";
import { ThreadTitleMenu } from "./ThreadTitleMenu";
import { ThreadTitleEditor } from "./ThreadTitleEditor";
import type { ThreadNodeType } from "../utils/buildThreadTree";

interface ThreadRowProps {
  thread: Thread;
  isActive: boolean;
  isDisabled?: boolean;
  isRenaming?: boolean;
  level?: number;
  nodeType?: ThreadNodeType;
  hasChildren?: boolean;
  onClick: () => void;
  onRename?: () => void;
  onRenameSubmit?: (newTitle: string) => void;
  onRenameCancel?: () => void;
  onDelete?: () => void;
}

const NODE_ICONS: Record<ThreadNodeType, LucideIcon> = {
  root: MessageSquare,
  branch: GitBranch,
  subagent: Bot,
};

/**
 * Single thread row.
 *
 * Single responsibility:
 * - Render one thread as a selectable item.
 * - Provide dropdown/context menu for rename and delete actions.
 * - Support inline editing when isRenaming is true.
 *
 * No data fetching; no knowledge of turns/streaming.
 */
export function ThreadRow({
  thread,
  isActive,
  isDisabled,
  isRenaming,
  level = 0,
  nodeType = "root",
  hasChildren = false,
  onClick,
  onRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: ThreadRowProps) {
  // Click guard to prevent ghost clicks on mobile.
  // When dropdown/context menu closes, browser may fire synthetic click on underlying element.
  // By setting this ref SYNCHRONOUSLY when menu action is clicked (before ghost click fires),
  // we can ignore the subsequent ghost click. See: https://github.com/radix-ui/primitives/issues/1242
  const ignoreClicksUntil = useRef(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Wrapper sets guard SYNCHRONOUSLY before calling the action
  const withClickGuard = (fn?: () => void) => {
    if (!fn) return undefined;
    return () => {
      ignoreClicksUntil.current = Date.now() + 300;
      fn();
    };
  };

  const handleRenameSubmit = (title: string) => {
    onRenameSubmit?.(title);
  };

  const handleRenameCancel = () => {
    onRenameCancel?.();
  };

  const Icon = NODE_ICONS[nodeType];

  // Context menu items (for right-click) - wrapped with click guard
  const contextMenuItems = (
    <>
      {onRename && (
        <ContextMenuItem onClick={withClickGuard(onRename)}>
          <Pencil className="size-3.5" />
          Rename
        </ContextMenuItem>
      )}
      {onRename && onDelete && <ContextMenuSeparator />}
      {onDelete && (
        <ContextMenuItem
          variant="destructive"
          onClick={withClickGuard(onDelete)}
        >
          <Trash2 className="size-3.5" />
          Delete
        </ContextMenuItem>
      )}
    </>
  );

  const itemContent = (
    <div
      className={cn(
        "group flex w-full items-center rounded-sm text-left text-sm transition-colors",
        "hover:bg-hover",
        isActive && "bg-sidebar-accent/50 font-medium",
        isDisabled && "pointer-events-none opacity-60",
      )}
      data-thread-node-type={nodeType}
      data-thread-level={level}
      data-thread-has-children={hasChildren || undefined}
    >
      <button
        type="button"
        disabled={isRenaming || isDisabled}
        onClick={
          isRenaming
            ? undefined
            : () => {
                // Ignore ghost clicks from dropdown/context menu actions
                if (Date.now() < ignoreClicksUntil.current) return;
                onClick();
              }
        }
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 py-2 pr-2.5 md:py-1",
          "font-inherit m-0 cursor-pointer appearance-none border-none bg-transparent text-left text-inherit",
        )}
        style={{
          // Match px-2.5 (10px) at level 0; reserve indent for future tree depth.
          paddingLeft: `${10 + level * 16}px`,
        }}
        aria-label={`Thread: ${thread.title || "Untitled Thread"}`}
        aria-current={isActive ? "page" : undefined}
        aria-disabled={isRenaming || isDisabled}
      >
        <Icon data-icon className="size-5 flex-shrink-0 md:size-4" />
        <div className="flex min-w-0 flex-1 flex-col">
          {isRenaming ? (
            <ThreadTitleEditor
              key={`rename-${thread.id}`}
              initialValue={thread.title || ""}
              onSubmit={handleRenameSubmit}
              onCancel={handleRenameCancel}
            />
          ) : (
            <span className="truncate">
              {thread.title || "Untitled Thread"}
            </span>
          )}
        </div>
      </button>

      {/* "..." button - visible on hover or when dropdown is open */}
      {!isRenaming && (onRename || onDelete) && (
        <ThreadTitleMenu
          open={dropdownOpen}
          onOpenChange={setDropdownOpen}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "h-7 w-9 flex-shrink-0 rounded-sm p-0 transition-opacity md:h-4 md:w-7",
                "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100",
                dropdownOpen && "opacity-100",
              )}
              aria-label="Thread options"
            >
              <MoreHorizontal className="size-4.5 md:size-4" />
            </Button>
          }
          onRename={withClickGuard(onRename)}
          onDelete={withClickGuard(onDelete)}
          align="end"
        />
      )}
    </div>
  );

  // Wrap with context menu for right-click support
  if (onRename || onDelete) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{itemContent}</ContextMenuTrigger>
        <ContextMenuContent>{contextMenuItems}</ContextMenuContent>
      </ContextMenu>
    );
  }

  return itemContent;
}
