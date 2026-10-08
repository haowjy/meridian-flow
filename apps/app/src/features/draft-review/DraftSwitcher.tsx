/**
 * DraftSwitcher — the Draft chip with its menu: which version of THIS document
 * is showing. The versions are the live document and its pending draft
 * (a document has one active draft per Work, so today that is two). Picking Live
 * leaves the review; the draft is the one already open. Moving between files is
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
import { useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DraftChipFace, draftChipHitClass } from "./DraftChip";

export type DraftSwitcherProps = {
  /** A draft-only document has no live version: it offers Close review instead. */
  draftOnly: boolean;
  disabled: boolean;
  onShowLive: () => void;
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t`Draft version`} className={draftChipHitClass(touch)}>
        <DraftChipFace state="reviewing" menu touch={touch}>
          <Trans>Draft</Trans>
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
          <DropdownMenuItem onSelect={onShowLive} className="pl-7">
            <Trans>Live version</Trans>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem aria-current="true" className="gap-2 font-medium">
          <Check aria-hidden className="size-3.5 text-primary" />
          <Trans>Draft</Trans>
        </DropdownMenuItem>
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
