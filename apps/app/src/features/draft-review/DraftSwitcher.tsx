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

export type DraftVersion = {
  key: string;
  name: ReactNode;
  detail?: ReactNode;
  note?: ReactNode;
  current: boolean;
  scope: boolean;
  onSelect: () => void;
};

export type DraftSwitcherProps = {
  label?: string;
  showing: "live" | "draft";
  drafts: readonly DraftVersion[];
  owner?: ReactNode;
  onShowLive?: () => void;
  onNewDraft?: () => void;
  onDeleteDraft?: () => void;
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
  rowRef?: (draft: DraftVersion, index: number) => Ref<HTMLButtonElement> | undefined;
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
