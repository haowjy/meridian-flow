/**
 * DraftSwitcher — the version chip with its menu: which version the view shows. A document's
 * header uses it for that document, and the sidebar for its trees (`TreeVersionChip`), so the
 * writer meets one Live/Draft control that names the version on screen. The versions are the live document and every draft of it, one
 * per owner (a Work, or a chat with no Work). The same chip and menu show on the
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
import { type ReactNode, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DisclosureMark } from "@/components/ui/marks";
import { DraftChipFace, draftChipHitClass } from "./DraftChip";

/** One owner's draft of the document, as the menu lists it. */
type DraftVersion = {
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
  /** What the chip chooses the version of, read before the version it names. */
  label?: string;
  /** The version on screen; its menu item is checked and the chip names it. */
  showing: "live" | "draft";
  /** Every owner's draft of the document. */
  drafts: readonly DraftVersion[];
  /** The draft on screen is not the picked Work's: the chip names its owner. */
  owner?: ReactNode;
  onShowLive: () => void;
  /** A phone's header: the trigger is a 44px target and its menu fits the screen. */
  touch?: boolean;
};

export function DraftSwitcher({
  label = t`Document version`,
  showing,
  drafts,
  owner,
  onShowLive,
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
        <VersionItem current={showing === "live"} onSelect={onShowLive}>
          <Trans>Live</Trans>
        </VersionItem>
        {drafts.length > 0 ? <DropdownMenuSeparator /> : null}
        {scoped.map((draft) => (
          <DraftVersionItem key={draft.key} draft={draft} />
        ))}
        {scoped.length > 0 && others.length > 0 ? <DropdownMenuSeparator /> : null}
        {others.length > 0 ? <OtherDrafts drafts={others} folded={scoped.length > 0} /> : null}
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

function DraftVersionItem({ draft }: { draft: DraftVersion }) {
  return (
    <DropdownMenuItem
      selected={draft.current}
      onSelect={draft.current ? undefined : draft.onSelect}
      className="h-auto min-h-8 flex-col items-start justify-center gap-0.5 coarse:h-auto coarse:min-h-11"
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
