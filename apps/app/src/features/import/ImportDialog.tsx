/**
 * Import dialog: says where the files will land and has one button. Takes a
 * folder or files, picked or dropped. Reading only lists names and sizes;
 * hashing happens after Import, in the background.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useId, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DroppedItems } from "@/lib/dropped-items";
import { cn } from "@/lib/utils";
import type { ImportDestination } from "./destination";
import { LandsSentences, limitSentence, SelectionCards, SelectionWarnings } from "./SelectionBody";
import { PickZone, useSelectionPicker } from "./SelectionPicker";
import type { Selection } from "./selection";
import { summarizeSelection } from "./summarize-selection";
import { useSelectionReader } from "./use-selection-reader";

export function ImportDialog({
  destination,
  dropped,
  onImport,
  onClose,
}: {
  destination: ImportDestination;
  dropped?: DroppedItems;
  onImport: (selection: Selection) => void;
  onClose: () => void;
}) {
  const reader = useSelectionReader(dropped);
  const picker = useSelectionPicker(reader);
  const state = reader.state;
  const summary = useMemo(
    () => (state.status === "ready" ? summarizeSelection(state.selection) : null),
    [state],
  );
  const refusal = summary && state.status === "ready" ? limitSentence(summary, state.origin) : null;
  const canImport = state.status === "ready" && summary !== null && summary.limit === "ok";
  const descriptionId = useId();
  const title = t`Import into ${destination.name}`;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[min(90svh,40rem)] max-w-lg flex-col gap-4"
        aria-describedby={descriptionId}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const first = state.status === "ready" ? "button[data-primary]" : "button[data-first]";
          (event.currentTarget as HTMLElement).querySelector<HTMLElement>(first)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-lg leading-tight font-semibold tracking-tight">
            {title}
          </DialogTitle>
        </DialogHeader>
        <div
          id={descriptionId}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
          {...picker.drag.props}
        >
          {picker.inputs}
          {state.status === "empty" || state.status === "reading" ? (
            <PickZone state={state} picker={picker} />
          ) : null}
          {state.status === "empty" ? (
            <DialogDescription className="text-caption text-ink-muted">
              <Trans>
                Markdown, text, Word and pictures. Obsidian links and embeds are converted.
              </Trans>
            </DialogDescription>
          ) : null}
          {state.status === "reading" ? (
            <DialogDescription className="sr-only">
              <Trans>Reading what you chose.</Trans>
            </DialogDescription>
          ) : null}
          {state.status === "ready" && summary ? (
            <>
              {summary.roots.length > 0 ? (
                <div className={cn("rounded-lg", picker.drag.over && "ring-1 ring-border-focus")}>
                  <SelectionCards summary={summary} />
                </div>
              ) : null}
              <div className="flex justify-end">
                <Button type="button" variant="ghost" size="sm" onClick={picker.chooseAgain}>
                  <Trans>Choose again</Trans>
                </Button>
              </div>
              {refusal ? (
                <DialogDescription role="alert" className="text-sm text-destructive">
                  {refusal}
                </DialogDescription>
              ) : (
                <DialogDescription className="grid gap-1 text-sm text-foreground">
                  <LandsSentences summary={summary} destination={destination.name} />
                </DialogDescription>
              )}
              <SelectionWarnings summary={summary} />
            </>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <DialogClose asChild>
            <Button type="button" variant="outline" className="[@media(pointer:coarse)]:min-h-11">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button
            type="button"
            data-primary
            aria-disabled={!canImport}
            aria-describedby={descriptionId}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
            onClick={() => state.status === "ready" && canImport && onImport(state.selection)}
          >
            {canImport && summary
              ? plural(summary.files, { one: "Import # file", other: "Import # files" })
              : t`Import`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
