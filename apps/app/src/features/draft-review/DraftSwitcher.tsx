/**
 * DraftSwitcher — the version chip with its menu: which version of THIS document
 * is showing. The versions are the live document and its pending draft
 * (a document has one active draft per Work, so today that is two). The same
 * chip and menu show on the live document (`showing="live"`, picking Draft
 * opens the review) and in review (picking Live leaves it), so the control the
 * writer used to get in is the one they use to get out. Moving between files is
 * not here: it belongs to the Changes list (`ReviewFiles`), which also holds
 * the Work-wide Apply all and Discard all.
 *
 * On a phone (`touch`) the header has no room for Apply draft, Discard draft or
 * the Show changes switch, so the menu carries them: pass `draftCommands` and
 * `marks` and they appear. Both are the same commands the desktop header runs.
 * Rename is offered when the row cannot show its own Rename chip.
 *
 * Presentational: it is handed the commands.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Check, Loader2 } from "lucide-react";
import { type ReactNode, useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";
import { cn } from "@/lib/utils";
import { DraftChipFace, draftChipHitClass } from "./DraftChip";

export type DraftSwitcherProps = {
  /** The version on screen; its menu item is checked and the chip names it. */
  showing?: "live" | "draft";
  /** A draft-only document has no live version: it offers Close review instead. */
  draftOnly: boolean;
  disabled: boolean;
  onShowLive: () => void;
  /** Opens the draft's review (live only). */
  onShowDraft?: () => void;
  /** The last attempt to open the review failed: the chip says so and Draft retries. */
  failed?: boolean;
  /** A phone's header: the trigger is a 44px target and its menu fits the screen. */
  touch?: boolean;
  /** Whole-draft commands for this document, offered in the menu (phone). Absent once nothing is left to publish. */
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
  showing = "draft",
  draftOnly,
  disabled,
  onShowLive,
  onShowDraft,
  failed = false,
  touch = false,
  draftCommands,
  marks,
  onRename,
}: DraftSwitcherProps) {
  // Rename opens a field that takes focus itself. It opens once the menu has finished
  // closing (the menu's own focus return would otherwise land after the field's focus
  // and leave it on the page), and the menu must not hand focus back to the chip.
  const renaming = useRef(false);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Document version`}
        disabled={disabled && showing === "live"}
        data-draft-review-chip={showing === "live" ? "" : undefined}
        data-draft-review-chip-failed={failed ? "" : undefined}
        className={cn(draftChipHitClass(touch), "disabled:opacity-50")}
      >
        <DraftChipFace
          state={failed ? "failed" : showing === "live" ? "pending" : "reviewing"}
          menu
          touch={touch}
        >
          {failed ? (
            <ReviewMessageText failure={{ code: "review-failed" }} />
          ) : showing === "live" ? (
            <Trans>Live</Trans>
          ) : (
            <Trans>Draft</Trans>
          )}
        </DraftChipFace>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={touch ? "w-[min(18rem,calc(100vw-1rem))]" : "w-60"}
        onCloseAutoFocus={(event) => {
          if (!renaming.current) return;
          renaming.current = false;
          event.preventDefault();
          onRename?.();
        }}
      >
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
          <Trans>Versions of this document</Trans>
        </DropdownMenuLabel>
        {draftOnly ? null : (
          <VersionItem current={showing === "live"} onSelect={onShowLive}>
            <Trans>Live version</Trans>
          </VersionItem>
        )}
        <VersionItem current={showing === "draft"} onSelect={onShowDraft}>
          <Trans>Draft</Trans>
        </VersionItem>
        {draftCommands || marks ? <DropdownMenuSeparator /> : null}
        {draftCommands ? (
          <>
            <DropdownMenuItem
              disabled={disabled || !draftCommands.canApply}
              onSelect={draftCommands.onApply}
              className="pl-7 font-medium"
            >
              {draftCommands.applying ? <Loader2 className="animate-spin" aria-hidden /> : null}
              <Trans>Apply draft</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={disabled}
              onSelect={draftCommands.onDiscard}
              className="pl-7"
            >
              <Trans>Discard draft</Trans>
            </DropdownMenuItem>
          </>
        ) : null}
        {marks ? (
          <DropdownMenuItem onSelect={() => marks.onChange(!marks.visible)} className="pl-7">
            {marks.visible ? <Trans>Hide changes</Trans> : <Trans>Show changes</Trans>}
          </DropdownMenuItem>
        ) : null}
        {onRename || draftOnly ? <DropdownMenuSeparator /> : null}
        {onRename ? (
          <DropdownMenuItem
            onSelect={() => {
              renaming.current = true;
            }}
            className="pl-7"
          >
            <Trans>Rename</Trans>
          </DropdownMenuItem>
        ) : null}
        {draftOnly ? (
          <DropdownMenuItem onSelect={onShowLive} className="pl-7">
            <Trans>Close review</Trans>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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
  return current ? (
    <DropdownMenuItem aria-current="true" className="gap-2 font-medium">
      <Check aria-hidden className="size-3.5 text-primary" />
      {children}
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem onSelect={onSelect} className="pl-7">
      {children}
    </DropdownMenuItem>
  );
}
