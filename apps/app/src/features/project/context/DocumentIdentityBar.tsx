/**
 * DocumentIdentityBar — the universal breadcrumb band at the top of the
 * active tab's canvas. One quiet mono path (`Scratch › Untitled 4`) on every
 * document; provisional docs are a *state* of the bar (italic leaf + jade
 * "Choose a home" chip), not separate chrome.
 *
 * Two affordances: click the path to type (the crumb row becomes a text
 * field), click the chip to browse. Phase 1 scopes the field to the basename
 * — path segments render as read-only spans and the chip opens the same
 * naming field; the move-first popup arrives with the cross-folder move seam.
 *
 * Keystroke-path contract: at rest the bar renders from tab metadata only.
 * The content-suggestion observer (300ms debounce) mounts only while the
 * field is open on a provisional doc — never while the writer is typing
 * prose.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { PenLine, TriangleAlert } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { renameContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { ContextTab } from "@/client/stores";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { cn } from "@/lib/utils";
import { invalidContextEntryNameReason } from "./context-entry-name";
import { schemeIcon, schemeLabel } from "./context-schemes";
import {
  FileSuggestionList,
  folderChildren,
  parentPath as parentFolderPath,
  useFileSuggestions,
} from "./file-suggestions";
import { suggestedNameFromFragment } from "./untitled-document-name";
import {
  clearQueuedRenameFailure,
  type QueuedRenameFailure,
  queueUntitledRename,
  useQueuedRenameFailure,
  useUntitledPendingSince,
} from "./untitled-reconciler";
import { ValidationNote } from "./validation-note";

export type DocumentIdentityBarProps = {
  projectId: string;
  activeThreadId: string | null;
  tab: ContextTab;
  onRenamed: (
    documentId: string,
    scheme: ProjectContextTreeScheme,
    name: string,
    path: string,
  ) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
};

/** Writer-facing location of a tab. A `new` tab has no server path yet — it
 *  lives in Scratch by construction, so the bar can say so before the server
 *  allocates anything. */
type TabLocation = {
  scheme: ProjectContextTreeScheme;
  /** `/` for a scheme root. */
  parentPath: string;
  folders: string[];
  leaf: string;
  provisional: boolean;
  editable: boolean;
  workId?: string;
  /** Server path, or null for a not-yet-materialized `new` tab. */
  path: string | null;
};

function tabLocation(tab: ContextTab): TabLocation {
  if (tab.kind === "new") {
    return {
      scheme: "scratch",
      parentPath: "/",
      folders: [],
      leaf: tab.name,
      provisional: true,
      editable: true,
      path: null,
    };
  }
  const segments = tab.path.split("/").filter(Boolean);
  return {
    scheme: tab.scheme,
    parentPath: parentFolderPath(tab.path),
    folders: segments.slice(0, -1),
    leaf: tab.name,
    provisional: tab.kind === "tracked" && Boolean(tab.provisionalName),
    // Phase 1 rides the shipped rename seam, which covers Yjs-tracked
    // documents; viewer files keep tree-action rename until the move seam.
    editable: tab.kind === "tracked",
    workId: tab.workId,
    path: tab.path,
  };
}

export function DocumentIdentityBar({
  projectId,
  activeThreadId,
  tab,
  onRenamed,
  onOpenExisting,
}: DocumentIdentityBarProps) {
  const location = tabLocation(tab);
  const [editing, setEditing] = useState(false);
  // "Writer owns the name" latch — once the writer edits the field, the
  // content suggestion stops prefilling for this document (shipped rule).
  const writerOwnsName = useRef(false);

  // A queued rename that failed after this document materialized reopens the
  // field with the writer's name restored and the failure's recovery note —
  // the receipt must never be dropped silently.
  const renameFailure = useQueuedRenameFailure(tab.documentId);
  useEffect(() => {
    if (!renameFailure) return;
    writerOwnsName.current = true;
    setEditing(true);
  }, [renameFailure]);

  const openEditor = () => {
    if (location.editable) setEditing(true);
  };

  return (
    <div className="@container shrink-0">
      <div
        className={cn(
          editorColumnChrome,
          "flex min-h-5.5 items-center gap-1 pt-1 font-mono text-ink-subtle text-meta",
        )}
      >
        {editing ? (
          <IdentityPathEditor
            projectId={projectId}
            activeThreadId={activeThreadId}
            tab={tab}
            location={location}
            writerOwnsName={writerOwnsName}
            failure={renameFailure}
            onExit={(reason) => {
              // Leaving the field acknowledges any failure receipt — it must
              // not reopen the editor it just closed.
              clearQueuedRenameFailure(tab.documentId);
              setEditing(false);
              if (reason === "escape") focusEditorProse(tab.documentId);
            }}
            onRenamed={onRenamed}
            onOpenExisting={onOpenExisting}
          />
        ) : (
          <IdentityPath
            location={location}
            onEdit={openEditor}
            onEscape={() => focusEditorProse(tab.documentId)}
          />
        )}
        <span className="min-w-1 flex-1" />
        <IdentityChipSlot
          documentId={tab.documentId}
          provisional={location.provisional}
          onNameDraft={openEditor}
        />
      </div>
    </div>
  );
}

/** Rest state: the quiet crumb row. Middle folders collapse to `…`; narrow
 *  containers drop the scheme label (glyph only) and folder names. */
function IdentityPath({
  location,
  onEdit,
  onEscape,
}: {
  location: TabLocation;
  onEdit: () => void;
  onEscape: () => void;
}) {
  const SchemeIcon = schemeIcon(location.scheme);
  const separator = (
    <span aria-hidden className="shrink-0 opacity-60">
      ›
    </span>
  );
  const segments = (
    <>
      <SchemeIcon aria-hidden className="size-3 shrink-0" />
      <span className="shrink-0 @max-md:hidden">{schemeLabel(location.scheme)}</span>
      {location.folders.length > 0 ? (
        <>
          {separator}
          <span className="flex min-w-0 items-center gap-1 @max-md:hidden">
            {location.folders.length > 1 ? (
              <>
                <span aria-hidden>…</span>
                {separator}
              </>
            ) : null}
            <span className="truncate">{location.folders[location.folders.length - 1]}</span>
          </span>
          <span aria-hidden className="hidden @max-md:inline">
            …
          </span>
        </>
      ) : null}
      {separator}
      <span className={cn("truncate text-ink-muted", location.provisional && "italic")}>
        {location.leaf}
      </span>
    </>
  );
  if (!location.editable) {
    return <span className="flex min-w-0 items-center gap-1">{segments}</span>;
  }
  return (
    <button
      type="button"
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key === "Escape") onEscape();
      }}
      aria-label={t`Document name and location`}
      className="focus-ring flex min-w-0 cursor-text items-center gap-1 rounded-sm text-left"
    >
      {segments}
    </button>
  );
}

type ExitReason = "escape" | "blur" | "commit";

/**
 * Edit mode: the path as one text field. Phase 1 renders the folder prefix as
 * a read-only span with `/` separators (typing grammar, not `›` display
 * grammar) and scopes the input to the basename. Enter commits a rename
 * through the shipped seam; Esc and blur revert.
 */
function IdentityPathEditor({
  projectId,
  activeThreadId,
  tab,
  location,
  writerOwnsName,
  failure,
  onExit,
  onRenamed,
  onOpenExisting,
}: DocumentIdentityBarProps & {
  location: TabLocation;
  writerOwnsName: RefObject<boolean>;
  failure: QueuedRenameFailure | null;
  onExit: (reason: ExitReason) => void;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => {
    if (failure) return failure.name;
    if (!location.provisional || writerOwnsName.current) return location.leaf;
    const suggestion = suggestionForTab(tab);
    return suggestion || location.leaf;
  });
  // Debounced copy of the draft that drives the visible validation note, so
  // the reason doesn't flash mid-word. Enter flushes it immediately.
  const [noteDraft, setNoteDraft] = useState(draft);
  const [browsePath, setBrowsePath] = useState(location.parentPath);
  const [serverConflict, setServerConflict] = useState(failure?.kind === "conflict");
  const [requestError, setRequestError] = useState<string | null>(() =>
    failure?.kind === "error" ? t`Couldn't rename this document. Try another name.` : null,
  );
  const [saving, setSaving] = useState(false);
  const suggestionTimer = useRef<number | null>(null);

  // Select the basename (minus extension) for overtype on entry, and again
  // whenever the suggestion refreshes underneath an untouched field.
  useEffect(() => {
    const input = inputRef.current;
    if (!input || writerOwnsName.current) return;
    input.focus();
    const extensionIndex = input.value.lastIndexOf(".");
    input.setSelectionRange(0, extensionIndex > 0 ? extensionIndex : input.value.length);
  }, [draft]);

  useEffect(() => {
    const timer = window.setTimeout(() => setNoteDraft(draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft]);

  // Content-suggested name keeps refreshing (300ms debounce, as shipped)
  // until the writer edits. Only mounted while the field is open on a
  // provisional doc — the bar at rest observes nothing.
  useEffect(() => {
    if (!location.provisional) return;
    const session = getDocumentSessionRegistry().getDetached(tab.documentId);
    const fragment = session.document.getXmlFragment(session.fragmentName);
    const refresh = () => {
      if (writerOwnsName.current) return;
      if (suggestionTimer.current !== null) window.clearTimeout(suggestionTimer.current);
      suggestionTimer.current = window.setTimeout(() => {
        suggestionTimer.current = null;
        // Re-check the latch at fire time — the writer may have taken the
        // name during the debounce window, and a stale timer must not
        // overwrite what they typed.
        if (writerOwnsName.current) return;
        const suggestion = suggestionForTab(tab);
        if (suggestion) setDraft(suggestion);
      }, 300);
    };
    fragment.observeDeep(refresh);
    return () => {
      fragment.unobserveDeep(refresh);
      if (suggestionTimer.current !== null) {
        window.clearTimeout(suggestionTimer.current);
        suggestionTimer.current = null;
      }
    };
  }, [location.provisional, tab, writerOwnsName]);

  const suggestionOptions = useMemo(
    () => ({
      schemes: [location.scheme],
      kinds: ["dir", "file"] as const,
      activeThreadId,
      workId: location.workId,
    }),
    [activeThreadId, location.scheme, location.workId],
  );
  const { suggestions: allEntries } = useFileSuggestions(projectId, "", suggestionOptions);
  const browseEntries = folderChildren(allEntries, location.scheme, browsePath);
  const siblingEntries = folderChildren(allEntries, location.scheme, location.parentPath);

  const name = draft.trim();
  const collision =
    siblingEntries.find((entry) => entry.name === name && entry.path !== location.path) ?? null;
  const validation = name ? invalidContextEntryNameReason(name) : t`Name is required`;

  // The note renders from the debounced draft so it lags typing, but a
  // blocked Enter flushes the current reason immediately (see submit).
  const noteName = noteDraft.trim();
  const noteCollision = collision && noteName === name ? collision : null;
  const noteValidation = noteName === name ? validation : null;
  const collisionPath =
    noteCollision?.path ??
    (failure?.kind === "conflict"
      ? failure.path
      : serverConflict && location.path
        ? replaceBasename(location.path, name)
        : null);
  const note =
    noteCollision || serverConflict ? (
      <ValidationNote
        severity={{
          level: "error",
          message: t`A file named ${name} already exists in this location.`,
        }}
        action={
          noteCollision?.kind !== "dir" && collisionPath ? (
            <button
              data-file-suggestion
              type="button"
              tabIndex={-1}
              className="focus-ring ml-1.5 cursor-pointer font-medium underline underline-offset-2"
              onClick={() =>
                onOpenExisting(
                  failure?.kind === "conflict" ? failure.scheme : location.scheme,
                  collisionPath,
                )
              }
            >
              <Trans>Open existing</Trans>
            </button>
          ) : undefined
        }
        className="m-1 mb-0"
      />
    ) : noteValidation ? (
      <ValidationNote severity={{ level: "error", message: noteValidation }} className="m-1 mb-0" />
    ) : requestError ? (
      <ValidationNote severity={{ level: "error", message: requestError }} className="m-1 mb-0" />
    ) : null;

  async function submit() {
    if (saving) return;
    if (!name || validation || collision) {
      // Enter on an invalid name commits nothing — it only makes sure the
      // reason is visible now, not a debounce later.
      setNoteDraft(draft);
      return;
    }
    if (name === location.leaf) {
      onExit("commit");
      return;
    }
    if (tab.kind === "new") {
      // The reconciler applies the rename when the document materializes; the
      // outcome lands as a receipt that reopens this field on failure.
      queueUntitledRename(tab.documentId, name);
      onExit("commit");
      return;
    }
    if (!location.path) return;
    setSaving(true);
    setRequestError(null);
    try {
      const result = await renameContextEntry(
        projectId,
        location.scheme,
        { path: location.path, newName: name },
        location.workId ? { workId: location.workId } : undefined,
      );
      if (result.status === "conflict") {
        setServerConflict(true);
        inputRef.current?.select();
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: projectQueryKeys.contextTree(projectId, location.scheme, location.workId),
      });
      onRenamed(tab.documentId, location.scheme, name, replaceBasename(location.path, name));
      onExit("commit");
    } catch {
      setRequestError(t`Couldn't rename this document. Try another name.`);
    } finally {
      setSaving(false);
    }
  }

  const prefix = `${schemeLabel(location.scheme)}/${location.folders.map((folder) => `${folder}/`).join("")}`;

  return (
    <Popover open>
      <PopoverAnchor asChild>
        <div className="flex min-w-0 max-w-96 flex-1 items-center rounded-sm border border-primary bg-card px-1.5 font-sans text-foreground text-xs">
          <span aria-hidden className="shrink-0 select-none whitespace-pre text-ink-subtle">
            {prefix}
          </span>
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent py-0.5 outline-none"
            aria-label={t`Document name and location`}
            value={draft}
            spellCheck={false}
            disabled={saving}
            aria-invalid={Boolean(validation || collision || serverConflict || requestError)}
            onChange={(event) => {
              writerOwnsName.current = true;
              if (suggestionTimer.current !== null) {
                window.clearTimeout(suggestionTimer.current);
                suggestionTimer.current = null;
              }
              clearQueuedRenameFailure(tab.documentId);
              setDraft(event.target.value);
              setServerConflict(false);
              setRequestError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") {
                event.preventDefault();
                onExit("escape");
              }
            }}
            onBlur={(event) => {
              // Enter is the only commit — clicking away reverts. Clicks
              // inside the suggestion popover stay within the field.
              const next = event.relatedTarget as HTMLElement | null;
              if (next?.closest("[data-file-suggestion]")) return;
              onExit("blur");
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        data-file-suggestion
        align="start"
        className="max-h-64 overflow-y-auto p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <FileSuggestionList
          header={note}
          suggestions={browseEntries}
          onSelect={(entry) => {
            if (entry.kind === "dir") {
              setBrowsePath(entry.path);
              inputRef.current?.focus();
              return;
            }
            onOpenExisting(location.scheme, entry.path);
          }}
          onClose={() => onExit("escape")}
          onNavigateUp={
            browsePath === "/" ? undefined : () => setBrowsePath(parentFolderPath(browsePath))
          }
          hideParents
          emptyMessage={t`Nothing here yet`}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Single-occupancy chip slot at the bar's right edge. Severity ladder:
 * device-only words (warning tokens, 2s sustained grace) outrank the naming
 * invitation. Named documents carry no chip in phase 1 — the standing
 * "Choose a home" move chip arrives with the move-first popup, and no
 * enabled control may promise a move it cannot perform.
 */
function IdentityChipSlot({
  documentId,
  provisional,
  onNameDraft,
}: {
  documentId: string;
  provisional: boolean;
  onNameDraft: () => void;
}) {
  const deviceOnly = useDeviceOnly(documentId);
  if (deviceOnly) return <DeviceOnlyChip />;
  if (!provisional) return null;
  return <NameDraftChip onClick={onNameDraft} />;
}

const chipClass =
  "inline-flex h-4.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 font-medium font-sans text-meta motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150";

/**
 * The naming invitation on provisional documents: jade ("do/go"), and
 * honest — clicking opens the naming field, and the copy says exactly that.
 */
function NameDraftChip({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "focus-ring cursor-pointer border-primary/30 bg-primary/10 text-jade-text",
            chipClass,
          )}
        >
          <PenLine aria-hidden className="size-2.5" />
          <span className="@max-md:hidden">
            <Trans>Name this draft</Trans>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} className="max-w-60">
        <Trans>This draft is untitled and lives in your Scratch. Click to give it a name.</Trans>
      </TooltipContent>
    </Tooltip>
  );
}

function DeviceOnlyChip() {
  const label = t`Only on this device`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          className={cn(chipClass, "border-warning-border bg-warning-bg text-warning-foreground")}
        >
          <TriangleAlert aria-hidden className="size-2.5" />
          <span className="@max-md:hidden">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const DEVICE_ONLY_GRACE_MS = 2_000;

/**
 * Device-only with a 2s sustained grace: the warning only claims the slot
 * once unsynced words have persisted for 2 seconds, so a normal quick
 * materialization never flashes warning chrome. The clock is the
 * reconciler's per-document `pendingSince` — remounting the bar (tab
 * switches) cannot restart the window.
 */
function useDeviceOnly(documentId: string): boolean {
  const since = useUntitledPendingSince(documentId);
  const [, bump] = useState(0);
  const sustained = since !== null && Date.now() - since >= DEVICE_ONLY_GRACE_MS;
  useEffect(() => {
    if (since === null || sustained) return;
    const timer = window.setTimeout(
      () => bump((tick) => tick + 1),
      DEVICE_ONLY_GRACE_MS - (Date.now() - since),
    );
    return () => window.clearTimeout(timer);
  }, [since, sustained]);
  return sustained;
}

function suggestionForTab(tab: ContextTab): string {
  const session = getDocumentSessionRegistry().getDetached(tab.documentId);
  const suggestion = suggestedNameFromFragment(
    session.document.getXmlFragment(session.fragmentName),
  );
  if (!suggestion || tab.kind === "new") return suggestion;
  const extensionIndex = tab.name.lastIndexOf(".");
  const extension = extensionIndex > 0 ? tab.name.slice(extensionIndex) : "";
  return extension && !suggestion.endsWith(extension) ? `${suggestion}${extension}` : suggestion;
}

function replaceBasename(path: string, name: string): string {
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;
}

/** Esc hands focus back to the prose (spec: the bar is one tab stop). */
function focusEditorProse(documentId: string) {
  document
    .querySelector<HTMLElement>(
      `[data-context-editor-document-id="${CSS.escape(documentId)}"] [contenteditable="true"]`,
    )
    ?.focus();
}
