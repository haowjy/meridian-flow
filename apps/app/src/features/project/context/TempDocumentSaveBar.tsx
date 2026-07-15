/**
 * TempDocumentSaveBar — the "Only on this device" row above a temp document.
 *
 * Pure presentation over `useTempDocumentSave`: one VS Code-style location
 * field speaking the context-URI grammar (`manuscript://folder/name`), a Save
 * button, and failure/conflict notices. While the field is focused a
 * navigable folder browser hangs under it: rows are the current folder's
 * contents (subfolders and files — overwrite awareness), clicking a folder
 * descends and stays open, `..` ascends (to the scheme list above the
 * roots), and clicking a file adopts its location + name. Every hop rewrites
 * the field and re-selects the name segment for overtyping. The row sits on
 * canvas, aligned to the prose column, and the surface-warm field carries
 * the form's shape.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { cn } from "@/lib/utils";
import {
  type FileSuggestion,
  FileSuggestionList,
  folderChildren,
  matchFileSuggestions,
  parentPath,
  useFileSuggestions,
} from "./file-suggestions";
import { ValidationNote } from "./InlineValidationOverlay";
import {
  DURABLE_SAVE_SCHEMES,
  formatSaveUri,
  parseSaveLocation,
  parseSaveUri,
  saveUriSuggestionQuery,
} from "./temp-save-uri";
import type { Destination, TempDocumentSave, TempSaveState } from "./use-temp-document-save";

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
  // Draft-while-editing: null renders the canonical URI derived from the hook
  // (so content-suggested names keep flowing into the field untouched); a
  // string means the writer is mid-edit and owns the exact text. Keystrokes
  // never touch the hook — mid-typing "manuscript://ge" must not rename the
  // document to "ge". The parse is committed on folder pick, blur, and
  // submit; submit passes it straight to `save(target)` so it can't race the
  // hook's async state commits.
  const [draft, setDraft] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Above the scheme roots sits one extra browse level — the scheme list.
  // It is not representable in the URI text (a URI always has a scheme), so
  // it is transient UI state, cleared by any navigation or typing.
  const [schemesView, setSchemesView] = useState(false);

  const text = draft ?? formatSaveUri(save.destination, save.name);
  const location = parseSaveLocation(text);
  const parsed = parseSaveUri(text);
  // The dropdown is a navigable folder browser (VS Code Save As): it shows
  // the current folder's contents — subfolders AND files, so the writer sees
  // what a name would collide with. The in-progress token narrows the view;
  // a token matching nothing (usually the file name) shows the full listing.
  const { suggestions: allEntries } = useFileSuggestions(projectId, "", {
    schemes: DURABLE_SAVE_SCHEMES,
    kinds: ["dir", "file"],
    activeThreadId,
  });
  // A trailing slash is a legal browse location before a name exists.
  const folder = location?.folder ?? save.destination;
  const children = folderChildren(allEntries, folder.scheme, folder.path);
  const token = saveUriSuggestionQuery(text);
  const matched = token ? matchFileSuggestions(children, token) : children;
  const suggestions = schemesView
    ? allEntries.filter((entry) => entry.path === "/")
    : matched.length > 0
      ? matched
      : children;

  /** Commit the current text into the hook's destination/name state. */
  const commitDraft = () => {
    if (!parsed) return;
    save.selectDestination(parsed.destination);
    if (parsed.name !== save.name) save.rename(parsed.name);
  };

  const submit = () => {
    if (!parsed || collision) return;
    commitDraft();
    void save.save(parsed);
  };

  /** Select the name segment so typing replaces it — the VS Code move. */
  const selectNameSegment = () => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.lastIndexOf("/") + 1, input.value.length);
  };

  /** Move the browser (and the field's folder part) to `destination`. */
  const navigateTo = (destination: Destination, name = save.name) => {
    save.selectDestination(destination);
    setDraft(formatSaveUri(destination, name));
    setSchemesView(false);
    requestAnimationFrame(selectNameSegment);
  };

  const selectEntry = (suggestion: FileSuggestion) => {
    if (suggestion.kind === "dir") {
      navigateTo({ scheme: suggestion.scheme, path: suggestion.path });
      return;
    }
    // Picking a file adopts its location and name: the live collision note
    // appears immediately and the name segment is selected for overtyping —
    // there is deliberately no overwrite path onto tracked documents.
    navigateTo({ scheme: suggestion.scheme, path: parentPath(suggestion.path) }, suggestion.name);
  };

  const navigateUp = () => {
    if (folder.path === "/") {
      setSchemesView(true);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    navigateTo({ scheme: folder.scheme, path: parentPath(folder.path) });
  };

  // Live collision check against the current folder's listing — the same
  // standard (message and look) as the tree's rename validation, surfaced
  // before save instead of as a server-conflict afterthought. The server 409
  // remains the race guard; it renders through the same note.
  const collision = parsed ? (children.find((c) => c.name === parsed.name) ?? null) : null;
  const conflict = save.saveState.kind === "conflict" ? save.saveState : null;
  const collisionNote =
    parsed && (collision || conflict) ? (
      <ValidationNote
        severity={{
          level: "error",
          message: t`A file named ${parsed.name} already exists in this location.`,
        }}
        action={
          collision?.kind !== "dir" ? (
            <button
              type="button"
              className="focus-ring ml-1.5 cursor-pointer font-medium underline underline-offset-2"
              onClick={() => {
                const path = conflict?.path ?? collision?.path;
                if (path) onOpenExisting(folder.scheme, path);
              }}
            >
              <Trans>Open existing</Trans>
            </button>
          ) : undefined
        }
        className="m-1 mb-0"
      />
    ) : null;

  const failure = save.saveState.kind === "failed" ? save.saveState : null;
  return (
    <section
      className={cn(editorColumnChrome, "@container py-2")}
      aria-label={t`Save temporary document`}
    >
      {/* One line, always — and never clipped: the shell around the prose
          column is overflow-hidden, so the field shrinks freely (min-w-0
          under a max cap) and, below the @md container width, the warning
          collapses to a tooltipped icon. Only failure notices may add a
          second line. */}
      <div className="flex items-center gap-2">
        <DeviceOnlyWarning />
        <Popover open={suggestionsOpen} onOpenChange={setSuggestionsOpen}>
          <PopoverAnchor asChild>
            <Input
              ref={inputRef}
              className="h-8 min-w-0 max-w-96 flex-1 bg-surface-warm"
              aria-label={t`Save location`}
              autoComplete="off"
              spellCheck={false}
              value={text}
              aria-invalid={
                parsed === null || collision !== null || conflict !== null || failure !== null
              }
              onFocus={() => setSuggestionsOpen(true)}
              onBlur={(event) => {
                // Focus moving into the suggestion list is not "leaving the
                // field": committing here would adopt an in-progress filter
                // token (e.g. `…://ge`) as the document name before the
                // folder pick lands.
                if (suggestionsRef.current?.contains(event.relatedTarget)) return;
                setSuggestionsOpen(false);
                if (!parsed) return;
                commitDraft();
                setDraft(null);
              }}
              onChange={(event) => {
                setDraft(event.target.value);
                setSchemesView(false);
                setSuggestionsOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
                if (event.key === "Escape") setSuggestionsOpen(false);
                if (event.key !== "ArrowDown" || !suggestionsOpen) return;
                event.preventDefault();
                suggestionsRef.current
                  ?.querySelector<HTMLButtonElement>("[data-file-suggestion]")
                  ?.focus();
              }}
            />
          </PopoverAnchor>
          <PopoverContent
            ref={suggestionsRef}
            align="start"
            className="max-h-64 overflow-y-auto p-0"
            onOpenAutoFocus={(event) => event.preventDefault()}
            // Navigation keeps the browser open: selecting a row returns
            // focus to the input (a "focus outside" to Radix) and clicking
            // the input is an "interact outside" — neither may dismiss.
            onFocusOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              if (event.target instanceof Node && inputRef.current?.contains(event.target)) {
                event.preventDefault();
              }
            }}
          >
            {/* VS Code layout: input, validation strip, then the listing. */}
            {collisionNote}
            <FileSuggestionList
              suggestions={suggestions}
              onSelect={selectEntry}
              onClose={() => setSuggestionsOpen(false)}
              onNavigateUp={schemesView ? undefined : navigateUp}
              hideParents
              emptyMessage={schemesView ? undefined : t`Nothing here yet`}
            />
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          className="shrink-0"
          disabled={save.saving || parsed === null || collision !== null}
          onClick={submit}
        >
          {save.saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
      {failure ? <SaveFailure state={failure} /> : null}
    </section>
  );
}

/**
 * Warning amber, not gray: this is the one line telling the writer their
 * words aren't in the project yet (cinnabar would read as error; gray buried
 * it). One slot owns the left position; the container width picks the
 * presentation — full sentence when roomy, tooltipped icon when tight.
 */
function DeviceOnlyWarning() {
  const label = t`Only on this device`;
  return (
    <div className="min-w-0 shrink-0 text-warning-foreground">
      <p className="min-w-0 truncate font-medium text-xs @max-md:hidden">{label}</p>
      <Tooltip>
        <TooltipTrigger asChild>
          <span role="img" aria-label={label} className="hidden @max-md:inline-flex">
            <TriangleAlert aria-hidden className="size-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Non-input failures only (network, newer-words race). Input errors —
 * collisions — render as the standard `ValidationNote` in the location
 * browser instead.
 */
function SaveFailure({ state }: { state: Extract<TempSaveState, { kind: "failed" }> }) {
  return (
    <p className="pt-1 text-right text-destructive text-xs" role="alert">
      {state.reason === "newer-words" ? (
        <Trans>Saved the snapshot and kept your newer words here.</Trans>
      ) : (
        <Trans>Couldn't save to your project. Nothing was lost — your words are still here.</Trans>
      )}
    </p>
  );
}
