/**
 * TempDocumentSaveBar — the "Only on this device" row above a temp document.
 *
 * Pure presentation over `useTempDocumentSave`: destination field with folder
 * suggestions, name field, Save, and failure/conflict notices. De-grayed and
 * de-lined per tab-direction E — the row sits on canvas, aligned to the prose
 * column, and the surface-warm fields carry the form's shape.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { cn } from "@/lib/utils";
import { schemeLabel } from "./context-schemes";
import { type FileSuggestion, FileSuggestionList, useFileSuggestions } from "./file-suggestions";
import type { Destination, TempDocumentSave, TempSaveState } from "./use-temp-document-save";

const DURABLE_SCHEMES = ["manuscript", "kb", "user"] as const;

export function TempDocumentSaveBar({
  projectId,
  activeThreadId,
  save,
  onOpenExisting,
}: {
  projectId: string;
  activeThreadId: string | null;
  save: TempDocumentSave;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
}) {
  const [destinationText, setDestinationText] = useState(() => formatDestination(save.destination));
  const [destinationOpen, setDestinationOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const { suggestions } = useFileSuggestions(projectId, destinationText, {
    schemes: DURABLE_SCHEMES,
    kinds: ["dir"],
    activeThreadId,
  });

  const selectDestination = (suggestion: FileSuggestion) => {
    const next = { scheme: suggestion.scheme, path: suggestion.path };
    save.selectDestination(next);
    setDestinationText(formatDestination(next));
    setDestinationOpen(false);
    requestAnimationFrame(() => nameInputRef.current?.focus());
  };

  const failure =
    save.saveState.kind === "failed" || save.saveState.kind === "conflict" ? save.saveState : null;
  return (
    <section className={cn(editorColumnChrome, "py-2")} aria-label={t`Save temporary document`}>
      {/* One line, always: fixed field widths can exceed the prose column, so
          the inputs are elastic (flex-1 between min/max) and shrink before
          anything wraps. Only failure notices may add a second line. */}
      <div className="flex items-center gap-2">
        {/* Warning amber, not gray: this is the one line telling the writer
            their words aren't in the project yet. Cinnabar would read as
            error; gray buried it. */}
        <p className="mr-auto min-w-0 truncate text-warning-foreground text-xs font-medium">
          <Trans>Only on this device</Trans>
        </p>
        <span className="shrink-0 text-muted-foreground text-xs">
          <Trans>Save to</Trans>
        </span>
        <Popover open={destinationOpen} onOpenChange={setDestinationOpen}>
          <PopoverAnchor asChild>
            <div className="relative min-w-28 max-w-52 flex-1">
              <Input
                className="h-8 w-full bg-surface-warm pr-7"
                aria-label={t`Destination folder`}
                autoComplete="off"
                value={destinationText}
                onFocus={(event) => {
                  setDestinationOpen(true);
                  event.currentTarget.select();
                }}
                onChange={(event) => {
                  setDestinationText(event.target.value);
                  setDestinationOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setDestinationOpen(false);
                  if (event.key !== "ArrowDown" || !destinationOpen) return;
                  event.preventDefault();
                  suggestionsRef.current
                    ?.querySelector<HTMLButtonElement>("[data-file-suggestion]")
                    ?.focus();
                }}
              />
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          </PopoverAnchor>
          <PopoverContent
            ref={suggestionsRef}
            align="start"
            className="max-h-64 overflow-y-auto p-0"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <FileSuggestionList
              suggestions={suggestions}
              onSelect={selectDestination}
              onClose={() => setDestinationOpen(false)}
              emptyMessage={t`No matching folders`}
            />
          </PopoverContent>
        </Popover>
        <span className="shrink-0 text-muted-foreground text-xs">
          <Trans>as</Trans>
        </span>
        <Input
          ref={nameInputRef}
          className="h-8 min-w-24 max-w-44 flex-1 bg-surface-warm"
          aria-label={t`File name`}
          value={save.name}
          onChange={(event) => save.rename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save.save();
          }}
          aria-invalid={failure !== null}
        />
        <Button
          size="sm"
          className="shrink-0"
          disabled={save.saving}
          onClick={() => void save.save()}
        >
          {save.saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
      {failure ? (
        <SaveFailure
          state={failure}
          onOpenExisting={onOpenExisting}
          onRename={() => nameInputRef.current?.focus()}
        />
      ) : null}
    </section>
  );
}

function SaveFailure({
  state,
  onOpenExisting,
  onRename,
}: {
  state: Extract<TempSaveState, { kind: "conflict" | "failed" }>;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
  onRename: () => void;
}) {
  if (state.kind === "failed") {
    return (
      <p className="pt-1 text-right text-destructive text-xs" role="alert">
        {state.reason === "newer-words" ? (
          <Trans>Saved the snapshot and kept your newer words here.</Trans>
        ) : (
          <Trans>
            Couldn't save to your project. Nothing was lost — your words are still here.
          </Trans>
        )}
      </p>
    );
  }
  return (
    <div className="flex items-center justify-end gap-2 pt-1 text-xs" role="alert">
      <p className="text-destructive">
        <Trans>
          “{state.snapshot.name}” already exists in {formatDestination(state.snapshot.destination)}.
        </Trans>
      </p>
      <Button
        size="xs"
        variant="quiet"
        onClick={() => onOpenExisting(state.snapshot.destination.scheme, state.path)}
      >
        <Trans>Open existing</Trans>
      </Button>
      <Button size="xs" variant="quiet" onClick={onRename}>
        <Trans>Rename</Trans>
      </Button>
    </div>
  );
}

function formatDestination(destination: Destination): string {
  const segments = destination.path.split("/").filter(Boolean);
  return [schemeLabel(destination.scheme), ...segments].join(" / ");
}
