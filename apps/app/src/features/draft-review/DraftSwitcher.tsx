/**
 * DraftSwitcher — the version chip with its menu: which version of THIS document
 * the view shows. The versions are the live document and every draft of it, one
 * per owner (a Work, or a chat with no Work). The same chip and menu show on the
 * live document (picking a draft shows it) and on a draft (picking Live leaves
 * it, picking another draft switches), so the control the writer used to get in
 * is the one they use to get out. Moving between files is not here: it belongs
 * to the sidebar's Changes tab (`ChangesSource`), which also
 * holds the Work-wide Apply all and Discard all.
 *
 * On a phone (`touch`) the header has no room for Apply draft, Discard draft or
 * the Show changes switch, so the menu carries them: pass `draftCommands` and
 * `marks` and they appear. Both are the same commands the desktop header runs.
 * Rename is offered when the row cannot show its own Rename chip.
 *
 * Presentational: it is handed the versions and the commands
 * (`DocumentVersionMenu` is its one container).
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DisclosureMark } from "@/components/ui/marks";
import { cn } from "@/lib/utils";
import { DraftChipFace, draftChipHitClass } from "./DraftChip";

/** One owner's draft of the document, as the menu lists it. */
export type DraftVersion = {
  key: string;
  /** The owner's name: its Work's, or the chat's for a draft with no Work. */
  name: ReactNode;
  /** What the draft does to the document besides its text (a move or delete). */
  detail?: ReactNode;
  /** The draft on screen. */
  current: boolean;
  /** The scope's own draft (the picked Work's, or the chat's): listed first, outside the fold. */
  scope: boolean;
  onSelect: () => void;
};

export type DraftSwitcherProps = {
  /** The version on screen; its menu item is checked and the chip names it. */
  showing: "live" | "draft";
  /** Every owner's draft of the document. */
  drafts: readonly DraftVersion[];
  /** The draft on screen is not the picked Work's: the chip names its owner. */
  owner?: ReactNode;
  /** A draft-only document has no live version: it offers Close review instead. */
  draftOnly: boolean;
  disabled: boolean;
  onShowLive: () => void;
  /** A phone's header: the trigger is a 44px target and its menu fits the screen. */
  touch?: boolean;
  /** Whole-draft commands for this document, offered in the menu (phone). Absent once nothing is left to apply. */
  draftCommands?: {
    canApply: boolean;
    applying: boolean;
    onApply: () => void;
    onDiscard: () => void;
  };
  /** The marks switch, offered in the menu (phone). */
  marks?: { visible: boolean; onChange: (visible: boolean) => void };
  /** Renames the document: the identity row has no room for its own Rename chip while in review. */
  onRename?: () => void;
};

export function DraftSwitcher({
  showing,
  drafts,
  owner,
  draftOnly,
  disabled,
  onShowLive,
  touch = false,
  draftCommands,
  marks,
  onRename,
}: DraftSwitcherProps) {
  // Rename opens a field that takes focus itself. It opens once the menu has finished
  // closing (the menu's own focus return would otherwise land after the field's focus
  // and leave it on the page), and the menu must not hand focus back to the chip.
  const renaming = useRef(false);
  const scoped = drafts.filter((draft) => draft.scope);
  const others = drafts.filter((draft) => !draft.scope);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Document version`}
        data-version-chip
        disabled={disabled && showing === "live"}
        data-draft-review-chip={showing === "live" ? "" : undefined}
        className={cn(draftChipHitClass(touch), "disabled:opacity-50")}
      >
        <DraftChipFace
          state={showing === "draft" ? "reviewing" : drafts.length > 0 ? "pending" : "live"}
          menu
          touch={touch}
        >
          {showing === "draft" ? (
            owner ? (
              <Trans>Draft: {owner}</Trans>
            ) : (
              <Trans>Draft</Trans>
            )
          ) : (
            <Trans>Live</Trans>
          )}
        </DraftChipFace>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={touch ? "w-[min(18rem,calc(100vw-1rem))]" : "w-60"}
        onCloseAutoFocus={(event) => {
          if (!renaming.current) return;
          renaming.current = false;
          event.preventDefault();
          onRename?.();
        }}
      >
        <DropdownMenuLabel>
          <Trans>Versions</Trans>
        </DropdownMenuLabel>
        {draftOnly ? null : (
          <VersionItem current={showing === "live"} onSelect={onShowLive}>
            <Trans>Live</Trans>
          </VersionItem>
        )}
        {drafts.length > 0 ? <DropdownMenuSeparator /> : null}
        {scoped.map((draft) => (
          <DraftItem key={draft.key} draft={draft} />
        ))}
        {scoped.length > 0 && others.length > 0 ? <DropdownMenuSeparator /> : null}
        {others.length > 0 ? <OtherDrafts drafts={others} folded={scoped.length > 0} /> : null}
        {draftCommands || marks ? <DropdownMenuSeparator /> : null}
        {draftCommands ? (
          <>
            <DropdownMenuItem
              disabled={disabled || !draftCommands.canApply}
              onSelect={draftCommands.onApply}
              className="font-medium"
            >
              {draftCommands.applying ? <Loader2 className="animate-spin" aria-hidden /> : null}
              <Trans>Apply draft</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled} onSelect={draftCommands.onDiscard}>
              <Trans>Discard draft</Trans>
            </DropdownMenuItem>
          </>
        ) : null}
        {marks ? (
          <DropdownMenuItem onSelect={() => marks.onChange(!marks.visible)}>
            {marks.visible ? <Trans>Hide changes</Trans> : <Trans>Show changes</Trans>}
          </DropdownMenuItem>
        ) : null}
        {onRename || draftOnly ? <DropdownMenuSeparator /> : null}
        {onRename ? (
          <DropdownMenuItem
            onSelect={() => {
              renaming.current = true;
            }}
          >
            <Trans>Rename</Trans>
          </DropdownMenuItem>
        ) : null}
        {draftOnly ? (
          <DropdownMenuItem onSelect={onShowLive}>
            <Trans>Close review</Trans>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The other owners' drafts, folded behind the scope's own unless one of them is on screen. The
 * menu remounts it on each open, so it folds again. Its toggle is a menu item, so arrows reach it, and picking it keeps the menu open.
 */
function OtherDrafts({ drafts, folded }: { drafts: readonly DraftVersion[]; folded: boolean }) {
  const [open, setOpen] = useState(() => !folded || drafts.some((draft) => draft.current));
  return (
    <>
      <DropdownMenuItem
        aria-expanded={open}
        onSelect={(event) => {
          event.preventDefault();
          setOpen(!open);
        }}
        className="gap-1 text-muted-foreground"
      >
        <DisclosureMark open={open} />
        <Trans>Other drafts</Trans>
      </DropdownMenuItem>
      {open ? drafts.map((draft) => <DraftItem key={draft.key} draft={draft} />) : null}
    </>
  );
}

function DraftItem({ draft }: { draft: DraftVersion }) {
  return (
    <DropdownMenuItem
      selected={draft.current}
      onSelect={draft.current ? undefined : draft.onSelect}
      className="h-auto min-h-8 flex-col items-start gap-0.5"
    >
      <span className="min-w-0 max-w-full truncate">{draft.name}</span>
      {draft.detail ? <span className="text-xs text-muted-foreground">{draft.detail}</span> : null}
    </DropdownMenuItem>
  );
}

function VersionItem({
  current,
  onSelect,
  children,
}: {
  current: boolean;
  onSelect?: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem selected={current} onSelect={current ? undefined : onSelect}>
      {children}
    </DropdownMenuItem>
  );
}
