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
 * canvas, aligned to the prose column, and the card field carries
 * the form's shape.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  DURABLE_SAVE_SCHEMES,
  formatSaveUri,
  parseSaveLocation,
  saveTargetFromLocation,
  saveUriSuggestionQuery,
} from "./temp-save-uri";
import type { Destination, TempDocumentSave, TempSaveState } from "./use-temp-document-save";
import { ValidationNote } from "./validation-note";

// Module-level so the options object (and its arrays) keep one identity —
// `useFileSuggestions` memoizes on it, and a fresh literal per render was
// silently defeating that cache on every keystroke.
const SAVE_LOCATION_SUGGESTIONS = {
  schemes: DURABLE_SAVE_SCHEMES,
  kinds: ["dir", "file"],
} as const;

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
  // document to "ge". The parse is committed via `commitTarget` on pick,
  // blur, and submit; submit passes it straight to `save(target)` so it
  // can't race the hook's async state commits.
  const [draft, setDraft] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  // Set when a close path is about to restore focus to the input (Escape
  // from a suggestion row): the focus event must not immediately reopen.
  const keepClosedOnFocusRef = useRef(false);

  const text = draft ?? formatSaveUri(save.destination, save.name);
  const location = parseSaveLocation(text);
  const parsed = saveTargetFromLocation(location);
  // The dropdown is a navigable folder browser (VS Code Save As): it shows
  // the current folder's contents — subfolders AND files, so the writer sees
  // what a name would collide with. The in-progress token narrows the view;
  // a token matching nothing (usually the file name) shows the full listing.
  const suggestionOptions = useMemo(
    () => ({ ...SAVE_LOCATION_SUGGESTIONS, activeThreadId }),
    [activeThreadId],
  );
  const { suggestions: allEntries } = useFileSuggestions(projectId, "", suggestionOptions);
  // A trailing slash is a legal browse location before a name exists. The
  // scheme list is the top browse level, shown whenever the text names no
  // scheme (empty field, half-typed scheme, or `..` past a root — which
  // rewrites the draft to the bare name). Never silently default into the
  // last committed folder.
  const folder = location?.folder ?? save.destination;
  const showSchemes = location === null;
  const level = showSchemes
    ? allEntries.filter((entry) => entry.path === "/")
    : folderChildren(allEntries, folder.scheme, folder.path);
  const token = saveUriSuggestionQuery(text);
  const matched = token ? matchFileSuggestions(level, token) : level;
  const suggestions = matched.length > 0 ? matched : level;

  /**
   * The one commit point: hook destination/name follow the given target.
   * Used by picks, blur, and submit — never by plain keystrokes.
   */
  const commitTarget = (destination: Destination, name: string) => {
    save.selectDestination(destination);
    // All callers pass a non-empty name (parsed targets and suggestion names
    // are non-empty by construction); the guard is belt-and-braces against
    // ever committing an empty rename.
    if (name && name !== save.name) save.rename(name);
  };

  const submit = () => {
    if (!parsed || collision) return;
    commitTarget(parsed.destination, parsed.name);
    void save.save(parsed);
  };

  /** Select the name segment so typing replaces it — the VS Code move. */
  const selectNameSegment = () => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.lastIndexOf("/") + 1, input.value.length);
  };

  /** Move the browser (and the field) to `destination`, committing it. */
  const navigateTo = (destination: Destination, name = save.name) => {
    commitTarget(destination, name);
    setDraft(formatSaveUri(destination, name));
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
      // Above a scheme root sits the scheme list. That level has no scheme,
      // so it IS representable in the text: the bare name. `showSchemes`
      // derives from the same parse as everything else.
      setDraft(location?.name ?? save.name);
      requestAnimationFrame(selectNameSegment);
      return;
    }
    navigateTo({ scheme: folder.scheme, path: parentPath(folder.path) });
  };

  // Live collision check against the browsed folder's listing (`level` IS
  // that listing whenever `parsed` exists — both derive from `location`) —
  // the same standard as the tree's rename validation, surfaced before save
  // instead of as a server-conflict afterthought.
  const collision = parsed ? (level.find((child) => child.name === parsed.name) ?? null) : null;
  // The server 409 remains the race guard (another client created the file;
  // the local tree may not even show it yet). It renders through the same
  // note using ITS target, not the current text — and any edit dismisses it,
  // handing coverage back to live validation.
  const conflict = save.saveState.kind === "conflict" ? save.saveState : null;
  useEffect(() => {
    // A conflict usually lands after Save-button click blurred the field and
    // closed the browser — reopen it so the note is seen, not just a red
    // border.
    if (conflict) setSuggestionsOpen(true);
  }, [conflict]);

  const noteName = conflict ? conflict.snapshot.name : (parsed?.name ?? null);
  const notePath = conflict ? conflict.path : collision ? collision.path : null;
  const noteScheme = conflict ? conflict.snapshot.destination.scheme : folder.scheme;
  const collisionNote =
    noteName && (collision || conflict) ? (
      <ValidationNote
        severity={{
          level: "error",
          message: t`A file named ${noteName} already exists in this location.`,
        }}
        action={
          notePath && collision?.kind !== "dir" ? (
            // `data-file-suggestion` enrolls the action in the browser's
            // roving arrow walk — its only keyboard route, since Tab exits
            // the popover and ArrowDown from the field targets the first
            // roving stop (this note sits above the rows in visual order).
            <button
              data-file-suggestion
              type="button"
              tabIndex={-1}
              className="focus-ring ml-1.5 cursor-pointer font-medium underline underline-offset-2"
              onClick={() => onOpenExisting(noteScheme, notePath)}
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
              className="h-8 min-w-0 max-w-96 flex-1 bg-card"
              aria-label={t`Save location`}
              autoComplete="off"
              spellCheck={false}
              value={text}
              aria-invalid={
                parsed === null || collision !== null || conflict !== null || failure !== null
              }
              onFocus={() => {
                // An Escape-from-row close restores focus here; that focus
                // must not immediately reopen the browser.
                if (keepClosedOnFocusRef.current) {
                  keepClosedOnFocusRef.current = false;
                  return;
                }
                setSuggestionsOpen(true);
              }}
              // Clicking the already-focused field fires no focus event —
              // after an Escape-close this is how the browser reopens.
              onClick={() => setSuggestionsOpen(true)}
              onBlur={(event) => {
                // Focus moving into the suggestion list is not "leaving the
                // field": committing here would adopt an in-progress filter
                // token (e.g. `…://ge`) as the document name before the
                // folder pick lands.
                if (suggestionsRef.current?.contains(event.relatedTarget)) return;
                setSuggestionsOpen(false);
                if (!parsed) return;
                commitTarget(parsed.destination, parsed.name);
                setDraft(null);
              }}
              onChange={(event) => {
                setDraft(event.target.value);
                // Editing dismisses a stale server conflict — live validation
                // takes over from here.
                if (conflict) save.clearFailure();
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
            onFocusOutside={(event) => {
              if (event.target === inputRef.current) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (event.target instanceof Node && inputRef.current?.contains(event.target)) {
                event.preventDefault();
              }
            }}
            // Tab anywhere in the browser (rows, the conflict note's action)
            // exits to a logical save-bar control instead of the portal's
            // DOM neighbor (<body>): backward → the field, forward → Save
            // when enabled, else the field.
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              event.preventDefault();
              setSuggestionsOpen(false);
              const forward = !event.shiftKey;
              const saveButton = saveButtonRef.current;
              if (forward && saveButton && !saveButton.disabled) {
                saveButton.focus();
                return;
              }
              keepClosedOnFocusRef.current = true;
              inputRef.current?.focus();
            }}
          >
            {/* VS Code layout: input, validation strip, then the listing.
                The note rides inside the list's roving boundary so its
                action is arrow-reachable. */}
            <FileSuggestionList
              header={collisionNote}
              suggestions={suggestions}
              onSelect={selectEntry}
              onClose={() => {
                // Escape from a row: close AND hand focus back to the input
                // (without the focus reopening the browser) so the writer's
                // position is never dumped on <body>.
                keepClosedOnFocusRef.current = true;
                setSuggestionsOpen(false);
                inputRef.current?.focus();
              }}
              onNavigateUp={showSchemes ? undefined : navigateUp}
              hideParents
              emptyMessage={showSchemes ? undefined : t`Nothing here yet`}
            />
          </PopoverContent>
        </Popover>
        <Button
          ref={saveButtonRef}
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
 * it). Warning ink never stands naked, so both variants keep it on the warm
 * warning field. One slot owns the left position; the container width picks
 * the presentation — full sentence when roomy, tooltipped icon when tight.
 */
function DeviceOnlyWarning() {
  const label = t`Only on this device`;
  return (
    <div className="min-w-0 shrink-0">
      <p className="inline-flex min-w-0 items-center gap-1 rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 font-medium text-warning-foreground text-xs @max-md:hidden">
        <TriangleAlert aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </p>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={label}
            className="hidden items-center rounded-full border border-warning-border bg-warning-bg p-1 text-warning-foreground @max-md:inline-flex"
          >
            <TriangleAlert aria-hidden className="size-3" />
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
      ) : state.reason === "newer-target" ? (
        <Trans>Saved to the earlier location — your new save location stays with this copy.</Trans>
      ) : (
        <Trans>Couldn't save to your project. Nothing was lost — your words are still here.</Trans>
      )}
    </p>
  );
}
