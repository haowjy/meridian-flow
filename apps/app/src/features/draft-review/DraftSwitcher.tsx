/**
 * DraftSwitcher — the version chip with its menu: which version the view shows. A document's
 * header uses it for that document, and the sidebar for its trees (`TreeVersionChip`), so the
 * writer meets one Live/Draft control that names the version on screen. The versions are the live
 * document and its drafts: the picked Work's (a Work has several), then other owners' (another
 * Work, or a chat with no Work). It makes a Work's drafts too: `+ New draft`, and `Delete draft`
 * for the one on screen. The same chip and menu show on the
 * live document (picking a draft shows it) and on a draft (picking Live leaves
 * it, picking another draft switches), so the control the writer used to get in
 * is the one they use to get out. Moving between files is not here: it belongs
 * to the sidebar's Changes tab (`ChangesSource`), which also
 * holds the Work-wide Apply all and Discard all.
 *
 * Presentational: it is handed the versions and the commands (`DocumentVersionMenu` for a
 * document, `TreeVersionChip` for the sidebar).
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Plus, Trash2 } from "lucide-react";
import { type ReactNode, type Ref, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { dropdownRowVariants } from "@/components/ui/dropdown-presentation";
import { handleListKeys } from "@/components/ui/list-keys";
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
  /** How much it changes, at the row's end ("2 files"). */
  note?: ReactNode;
  /** The draft on screen. */
  current: boolean;
  /** The scope's own draft (the picked Work's, or the chat's): listed first, outside the fold. */
  scope: boolean;
  onSelect: () => void;
};

export type DraftSwitcherProps = {
  /** What the chip chooses the version of, read before the version it names. */
  label?: string;
  /** The version on screen; its menu item is checked and the chip names it. */
  showing: "live" | "draft";
  /** Every owner's draft of the document. */
  drafts: readonly DraftVersion[];
  /** The chip names the draft: its owner's when it is not the picked Work's, or its own name among several. */
  owner?: ReactNode;
  /** Absent on a page only a draft holds: Live has no version of it to show. */
  onShowLive?: () => void;
  /** `+ New draft` in the picked Work: makes one and shows it. */
  onNewDraft?: () => void;
  /** `Delete draft`: deletes the draft on screen. */
  onDeleteDraft?: () => void;
  /** A phone's header: the trigger is a 44px target and its menu fits the screen. */
  touch?: boolean;
};

export function DraftSwitcher({
  label = t`Document version`,
  showing,
  drafts,
  owner,
  onShowLive,
  onNewDraft,
  onDeleteDraft,
  touch = false,
}: DraftSwitcherProps) {
  const scoped = drafts.filter((draft) => draft.scope);
  const others = drafts.filter((draft) => !draft.scope);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-version-chip className={draftChipHitClass(touch)}>
        <span className="sr-only">{label}: </span>
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
      >
        <DropdownMenuLabel>
          <Trans>Versions</Trans>
        </DropdownMenuLabel>
        {onShowLive ? (
          <>
            <VersionItem current={showing === "live"} onSelect={onShowLive}>
              <Trans>Live</Trans>
            </VersionItem>
            {drafts.length > 0 ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        <WorkDraftRows as="menu" drafts={scoped} onNewDraft={onNewDraft} />
        {others.length > 0 ? <DropdownMenuSeparator /> : null}
        {others.length > 0 ? <OtherDrafts drafts={others} folded={scoped.length > 0} /> : null}
        {onDeleteDraft && showing === "draft" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDeleteDraft}>
              <Trash2 className="size-3.5" aria-hidden />
              <Trans>Delete draft</Trans>
            </DropdownMenuItem>
          </>
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
      {open ? drafts.map((draft) => <DraftVersionItem key={draft.key} draft={draft} />) : null}
    </>
  );
}

/**
 * The picked Work's drafts and `+ New draft`: one list, the same rows in a version chip's menu and
 * in a chat's `Writes into` panel, so picking a draft reads and behaves alike in both. Only the
 * presentation differs: menu items in the chip (`as: "menu"`), and in the panel, whose toolbar
 * owns the popover, the drafts as a radio group with `New draft` after it.
 */
export function WorkDraftRows({
  as,
  drafts,
  onNewDraft,
  rowRef,
  label,
}: {
  as: "menu" | "radio";
  drafts: readonly DraftVersion[];
  onNewDraft?: () => void;
  /** A panel's focus targets (`as: "radio"`). */
  rowRef?: (draft: DraftVersion, index: number) => Ref<HTMLButtonElement> | undefined;
  /** The radio group's accessible name. */
  label?: string;
}) {
  const Row = as === "menu" ? MenuRow : PanelRow;
  const rows = drafts.map((draft, index) => (
    <Row
      key={draft.key}
      checked={draft.current}
      onSelect={draft.onSelect}
      rowRef={rowRef?.(draft, index)}
      className={draftRowClass}
    >
      <DraftVersionLabel draft={draft} />
    </Row>
  ));
  const create = onNewDraft ? (
    <Row onSelect={onNewDraft}>
      <NewDraftLabel />
    </Row>
  ) : null;
  if (as === "menu")
    return (
      <>
        {rows}
        {create}
      </>
    );
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" onKeyDown={handleListKeys}>
      <div role="radiogroup" aria-label={label}>
        {rows}
      </div>
      {create}
    </fieldset>
  );
}

/** One row of a draft list: a draft (`checked` on the one in use) or `New draft`. */
type RowProps = {
  checked?: boolean;
  onSelect: () => void;
  rowRef?: Ref<HTMLButtonElement>;
  className?: string;
  children: ReactNode;
};

function MenuRow({ checked, onSelect, className, children }: RowProps) {
  return (
    <DropdownMenuItem
      selected={checked}
      onSelect={checked ? undefined : onSelect}
      className={className}
    >
      {children}
    </DropdownMenuItem>
  );
}

/** A panel's row: a draft is a radio of the group, `New draft` a button after it. */
function PanelRow({ checked, onSelect, rowRef, className, children }: RowProps) {
  return (
    <Button
      data-list-item
      ref={rowRef}
      role={checked === undefined ? undefined : "radio"}
      aria-checked={checked}
      variant="ghost"
      className={cn(dropdownRowVariants({ selected: checked ?? false }), className)}
      onClick={onSelect}
    >
      {children}
    </Button>
  );
}

const draftRowClass =
  "h-auto min-h-8 flex-col items-start justify-center gap-0.5 coarse:h-auto coarse:min-h-11";

function NewDraftLabel() {
  return (
    <>
      <Plus className="size-3.5 text-muted-foreground" aria-hidden />
      <Trans>New draft</Trans>
    </>
  );
}

function DraftVersionItem({ draft }: { draft: DraftVersion }) {
  return (
    <MenuRow checked={draft.current} onSelect={draft.onSelect} className={draftRowClass}>
      <DraftVersionLabel draft={draft} />
    </MenuRow>
  );
}

function DraftVersionLabel({ draft }: { draft: DraftVersion }) {
  return (
    <>
      <span className="flex w-full min-w-0 items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-left">{draft.name}</span>
        {draft.note ? (
          <span className="shrink-0 text-xs text-muted-foreground">{draft.note}</span>
        ) : null}
      </span>
      {draft.detail ? <span className="text-xs text-muted-foreground">{draft.detail}</span> : null}
    </>
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
