import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FilePlus, FolderPlus, Plus } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";

/**
 * The heading over one source in Write mode's sidebar: its name, and one + that
 * shows on hover with what can be made there. Drops land on it like on a tree row.
 */
export function SourceHeading({
  label,
  title,
  onCreate,
  extra,
  dropProps,
}: {
  label: string;
  /** Full name for the tooltip when the label is cut. */
  title?: string;
  onCreate?: (kind: "file" | "folder") => void;
  /** A source-specific control beside the + (Import). */
  extra?: ReactNode;
  dropProps?: HTMLAttributes<HTMLElement>;
}) {
  return (
    <div
      {...dropProps}
      className="group/source flex h-8 shrink-0 items-center gap-1 pr-2 pl-4"
      title={title}
    >
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{label}</h2>
      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/source:opacity-100 group-hover/source:opacity-100">
        {extra}
        {onCreate ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" aria-label={t`New in ${label}`} title={t`New in ${label}`}>
                <Plus className="size-4" aria-hidden />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onCreate("file")}>
                <FilePlus className="size-4" aria-hidden />
                <Trans>New document</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onCreate("folder")}>
                <FolderPlus className="size-4" aria-hidden />
                <Trans>New folder</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </span>
    </div>
  );
}
