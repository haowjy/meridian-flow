/**
 * The identity bar's typed surface, in two grammars:
 *
 * - **placement** (untitled docs never explicitly renamed or homed): the
 *   field opens EMPTY — the content-derived suggestion is ghost text
 *   (placeholder), accepted with Tab/→, never editable content the writer
 *   must delete. The popover opens on the scheme roots (the roots ARE the
 *   context choice) and picking drills into folders, building the path as
 *   read-only spans left of the name. Enter with a home built commits a move
 *   (+rename); name-only Enter renames in place — naming isn't homing.
 *   Placement happens once: any explicit save graduates the document to the
 *   path grammar.
 * - **path** (homed docs): the whole human path is one editable input.
 *   The popover tracks the caret's segment (root labels, then folders);
 *   typed segments that match nothing are tagged "new folder" and are
 *   created by the move. Enter is the single commit: rename, move, or both.
 *   (No rest-state entry currently reaches this grammar — the crumbs went
 *   inert while they await the per-segment navigator; the grammar stays for
 *   that slice to reclaim as its typed fallback.)
 *
 * Esc AND blur revert in both grammars — Enter or the ✓ button commits, Esc
 * or the × button cancels; the buttons are additive mirrors of the keys.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Check, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ContextTab } from "@/client/stores";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { cn } from "@/lib/utils";
import { invalidContextEntryNameReason, invalidContextEntryPathReason } from "./context-entry-name";
import { schemeLabel } from "./context-schemes";
import {
  type AnnotatedFileSuggestion,
  FileSuggestionList,
  folderChildren,
  parentPath as parentFolderPath,
  useFileSuggestions,
} from "./file-suggestions";
import { IDENTITY_BAR_BOX_CLASS } from "./identity-bar-geometry";
import type { TabLocation } from "./identity-location";
import {
  canonicalizeFolders,
  formatHumanPath,
  humanPathRoots,
  MOVE_DESTINATION_SCHEMES,
  matchRootLabel,
  segmentAtCaret,
} from "./identity-path";
import { suggestedNameFromFragment } from "./untitled-document-name";
import { clearQueuedRenameFailure, type QueuedRenameFailure } from "./untitled-reconciler";
import type { IdentityCommitOutcome, IdentityCommitTarget } from "./use-identity-commit";
import { ValidationNote } from "./validation-note";

export type IdentityFieldMode =
  | { kind: "placement" }
  | { kind: "path"; initialSegment: number | "leaf" };

type ExitReason = "escape" | "blur" | "commit";

type ConflictLocator = { scheme: ProjectContextTreeScheme; path: string; workId?: string };

export function IdentityPathField({
  projectId,
  activeThreadId,
  defaultWorkId,
  tab,
  location,
  mode,
  failure,
  commit,
  onExit,
  onOpenExisting,
}: {
  projectId: string;
  activeThreadId: string | null;
  defaultWorkId: string | null;
  tab: ContextTab;
  location: TabLocation;
  mode: IdentityFieldMode;
  failure: QueuedRenameFailure | null;
  commit: (target: IdentityCommitTarget) => Promise<IdentityCommitOutcome>;
  onExit: (reason: ExitReason) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionTimer = useRef<number | null>(null);
  const placement = mode.kind === "placement";

  // Placement: the chosen home so far (null = still on the roots).
  const [dest, setDest] = useState<{
    scheme: ProjectContextTreeScheme;
    folderPath: string;
  } | null>(null);

  // Placement opens EMPTY — the suggestion is ghost text, never content the
  // writer must delete. A failed queued placement restores the typed name.
  const [value, setValue] = useState(() => {
    if (placement) return failure?.name ?? "";
    return formatHumanPath(location.scheme, location.folders, location.leaf);
  });
  const [ghost, setGhost] = useState(() => (placement ? suggestionForTab(tab) : ""));
  // Debounced copy driving the visible note so reasons don't flash mid-word;
  // a blocked Enter flushes it immediately.
  const [noteValue, setNoteValue] = useState(value);
  const [conflict, setConflict] = useState<ConflictLocator | null>(() =>
    failure?.kind === "conflict"
      ? { scheme: failure.scheme, path: failure.path, workId: failure.workId }
      : null,
  );
  const [requestError, setRequestError] = useState<string | null>(() =>
    failure?.kind === "error" ? t`Couldn't rename this document. Try another name.` : null,
  );
  const [commitReason, setCommitReason] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [caret, setCaret] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setNoteValue(value), 300);
    return () => window.clearTimeout(timer);
  }, [value]);

  // Initial focus + selection. Placement starts empty (a restored failure
  // name is selected for overtype); path mode selects the clicked segment.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    if (placement) {
      if (input.value) input.select();
      return;
    }
    if (mode.kind !== "path") return;
    const segments = input.value.split("/");
    if (mode.initialSegment === "leaf") {
      const leafStart = input.value.length - (segments[segments.length - 1]?.length ?? 0);
      const leaf = segments[segments.length - 1] ?? "";
      const extensionIndex = leaf.lastIndexOf(".");
      input.setSelectionRange(
        leafStart,
        extensionIndex > 0 ? leafStart + extensionIndex : input.value.length,
      );
      setCaret(input.value.length);
      return;
    }
    let start = 0;
    for (let index = 0; index < mode.initialSegment && index < segments.length; index += 1) {
      start += (segments[index]?.length ?? 0) + 1;
    }
    const end = start + (segments[Math.min(mode.initialSegment, segments.length - 1)]?.length ?? 0);
    input.setSelectionRange(start, end);
    setCaret(end);
    // Selection is a mount-time gesture only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The ghost suggestion keeps refreshing (300ms debounce) while the field is
  // open; it can never overwrite typed content because it is only a
  // placeholder until the writer accepts it.
  useEffect(() => {
    if (!placement) return;
    const session = getDocumentSessionRegistry().getDetached(tab.documentId);
    const fragment = session.document.getXmlFragment(session.fragmentName);
    const refresh = () => {
      if (suggestionTimer.current !== null) window.clearTimeout(suggestionTimer.current);
      suggestionTimer.current = window.setTimeout(() => {
        suggestionTimer.current = null;
        setGhost(suggestionForTab(tab));
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
  }, [placement, tab]);

  const roots = useMemo(() => humanPathRoots(location.scheme), [location.scheme]);
  const suggestionOptions = useMemo(
    () => ({
      schemes: [...new Set([...MOVE_DESTINATION_SCHEMES, location.scheme])],
      kinds: ["dir", "file"] as const,
      activeThreadId,
      workId: defaultWorkId ?? location.workId,
    }),
    [activeThreadId, defaultWorkId, location.scheme, location.workId],
  );
  const { suggestions: allEntries } = useFileSuggestions(projectId, "", suggestionOptions);

  const rootRows: AnnotatedFileSuggestion[] = useMemo(
    () =>
      MOVE_DESTINATION_SCHEMES.map((scheme) => ({
        scheme,
        path: "/",
        name: schemeLabel(scheme),
        kind: "dir" as const,
        parents: [],
      })),
    [],
  );

  // ---- placement derivations -------------------------------------------
  const placementPrefix = dest
    ? `${[schemeLabel(dest.scheme), ...treeSegments(dest.folderPath)].join("/")}/`
    : "";
  const placementRows: AnnotatedFileSuggestion[] = dest
    ? folderChildren(allEntries, dest.scheme, dest.folderPath)
    : rootRows;

  // ---- path-mode derivations -------------------------------------------
  const pathSegments = value.split("/");
  const activeSegment = segmentAtCaret(value, caret);
  const pathRows: AnnotatedFileSuggestion[] = useMemo(() => {
    if (placement) return [];
    const typed = activeSegment.text.trim().toLocaleLowerCase();
    if (activeSegment.index === 0) {
      return rootRows.filter((row) => row.name.toLocaleLowerCase().includes(typed));
    }
    const scheme = matchRootLabel(pathSegments[0] ?? "", roots);
    if (!scheme) return [];
    const prefix = canonicalizeFolders(
      allEntries,
      scheme,
      pathSegments.slice(1, activeSegment.index),
    );
    if (prefix.missing.length > 0) return [];
    const children = folderChildren(allEntries, scheme, prefix.resolvedPath).filter(
      (child) => child.kind === "dir" && child.name.toLocaleLowerCase().includes(typed),
    );
    const isLast = activeSegment.index === pathSegments.length - 1;
    const exact = children.some((child) => child.name.toLocaleLowerCase() === typed);
    const newFolderRow: AnnotatedFileSuggestion[] =
      !isLast && typed && !exact
        ? [
            {
              scheme,
              path: `${prefix.resolvedPath === "/" ? "" : prefix.resolvedPath}/${activeSegment.text.trim()}`,
              name: activeSegment.text.trim(),
              kind: "dir" as const,
              parents: [],
              hint: t`new folder`,
            },
          ]
        : [];
    return [...children, ...newFolderRow];
  }, [placement, activeSegment, pathSegments, roots, allEntries, rootRows]);

  // ---- validation -------------------------------------------------------
  const rootLabels = useMemo(() => roots.map((scheme) => schemeLabel(scheme)), [roots]);
  const trimmedNote = noteValue.trim();
  const liveReason = placement
    ? trimmedNote
      ? invalidContextEntryNameReason(trimmedNote)
      : null
    : pathModeReason(noteValue, roots, rootLabels, allEntries);
  const localCollision = useMemo(() => {
    const name = noteValue.trim();
    if (placement) {
      if (!name) return null;
      const scheme = dest?.scheme ?? location.scheme;
      const folder = dest?.folderPath ?? location.parentPath;
      const hit = folderChildren(allEntries, scheme, folder).find(
        (entry) => entry.name === name && entry.path !== location.path,
      );
      return hit ? { scheme, path: hit.path, kind: hit.kind } : null;
    }
    const parsed = parseTypedPath(noteValue, roots, allEntries);
    if (!parsed) return null;
    if (parsed.newFolders.length > 0) return null;
    const folder = parsed.folders.length ? `/${parsed.folders.join("/")}` : "/";
    const samePlace = parsed.scheme === location.scheme && folder === location.parentPath;
    const hit = folderChildren(allEntries, parsed.scheme, folder).find(
      (entry) => entry.name === parsed.leaf && !(samePlace && entry.path === location.path),
    );
    return hit ? { scheme: parsed.scheme, path: hit.path, kind: hit.kind } : null;
  }, [placement, noteValue, dest, location, allEntries, roots]);

  const conflictName = conflict ? conflict.path.slice(conflict.path.lastIndexOf("/") + 1) : null;
  const note = conflict ? (
    <ValidationNote
      severity={{
        level: "error",
        message: t`A file named ${conflictName ?? ""} already exists in this location.`,
      }}
      action={
        <button
          data-file-suggestion
          type="button"
          tabIndex={-1}
          className="focus-ring ml-1.5 cursor-pointer font-medium underline underline-offset-2"
          onClick={() => onOpenExisting(conflict.scheme, conflict.path)}
        >
          <Trans>Open existing</Trans>
        </button>
      }
      className="m-1 mb-0"
    />
  ) : localCollision ? (
    <ValidationNote
      severity={{
        level: "error",
        message: t`A file named ${noteValue.trim().split("/").pop() ?? ""} already exists in this location.`,
      }}
      action={
        localCollision.kind !== "dir" ? (
          <button
            data-file-suggestion
            type="button"
            tabIndex={-1}
            className="focus-ring ml-1.5 cursor-pointer font-medium underline underline-offset-2"
            onClick={() => onOpenExisting(localCollision.scheme, localCollision.path)}
          >
            <Trans>Open existing</Trans>
          </button>
        ) : undefined
      }
      className="m-1 mb-0"
    />
  ) : (commitReason ?? liveReason) ? (
    <ValidationNote
      severity={{ level: "error", message: commitReason ?? liveReason ?? "" }}
      className="m-1 mb-0"
    />
  ) : requestError ? (
    <ValidationNote severity={{ level: "error", message: requestError }} className="m-1 mb-0" />
  ) : null;

  // ---- commit -----------------------------------------------------------
  async function submit() {
    if (saving) return;
    setCommitReason(null);
    if (placement) {
      // Enter with an empty field accepts the ghost (the human journey is
      // chip → pick a folder → Enter); with no ghost the server name stands.
      const name = value.trim() || ghost || location.leaf;
      if (!name) {
        setCommitReason(t`Name is required`);
        return;
      }
      const reason = invalidContextEntryNameReason(name);
      if (reason) {
        setCommitReason(reason);
        setNoteValue(value);
        return;
      }
      if (placementCollisionNow(name)) {
        setNoteValue(value || name);
        return;
      }
      if (!dest && name === location.leaf) {
        // Nothing typed, nothing picked: leaving is the only honest commit.
        onExit("commit");
        return;
      }
      await runCommit({
        destination: dest ? { scheme: dest.scheme, folderPath: dest.folderPath } : null,
        name,
      });
      return;
    }
    const parsed = parseTypedPath(value, roots, allEntries);
    if (!parsed) {
      const reason =
        pathModeReason(value, roots, rootLabels, allEntries) ??
        t`Include a location and a name, like Manuscript/chapter-1`;
      setCommitReason(reason);
      setNoteValue(value);
      return;
    }
    if (localCollisionNow()) {
      setNoteValue(value);
      return;
    }
    const folderPath = parsed.folders.length ? `/${parsed.folders.join("/")}` : "/";
    const unchangedLocation =
      parsed.scheme === location.scheme && folderPath === location.parentPath;
    if (unchangedLocation && parsed.leaf === location.leaf) {
      // The committed value IS the current truth: leave quietly, same as Esc.
      onExit("commit");
      return;
    }
    await runCommit({
      destination: unchangedLocation ? null : { scheme: parsed.scheme, folderPath },
      name: parsed.leaf,
    });
  }

  function placementCollisionNow(name: string): boolean {
    const scheme = dest?.scheme ?? location.scheme;
    const folder = dest?.folderPath ?? location.parentPath;
    return folderChildren(allEntries, scheme, folder).some(
      (entry) => entry.name === name && entry.path !== location.path,
    );
  }

  function localCollisionNow(): boolean {
    // The note is debounced; Enter validates against the live value.
    setNoteValue(value);
    const parsed = parseTypedPath(value, roots, allEntries);
    if (!parsed || parsed.newFolders.length > 0) return false;
    const folder = parsed.folders.length ? `/${parsed.folders.join("/")}` : "/";
    const samePlace = parsed.scheme === location.scheme && folder === location.parentPath;
    return folderChildren(allEntries, parsed.scheme, folder).some(
      (entry) => entry.name === parsed.leaf && !(samePlace && entry.path === location.path),
    );
  }

  async function runCommit(target: IdentityCommitTarget) {
    setSaving(true);
    setRequestError(null);
    try {
      const outcome = await commit(target);
      if (outcome.status === "conflict") {
        setConflict(outcome.locator);
        inputRef.current?.select();
        return;
      }
      if (outcome.status === "error") {
        setRequestError(outcome.message);
        return;
      }
      onExit("commit");
    } finally {
      setSaving(false);
    }
  }

  const clearFeedback = () => {
    setConflict(null);
    setRequestError(null);
    setCommitReason(null);
    clearQueuedRenameFailure(tab.documentId);
  };

  return (
    <Popover open>
      <PopoverAnchor asChild>
        <div
          className={cn(
            // A band-height box (borders included — see identity-bar-geometry):
            // the field occupies exactly the box the crumbs sat in, so
            // entering edit mode never shifts the chrome below.
            "flex min-w-0 flex-1 items-center rounded-sm border border-primary bg-card px-1.5 font-sans text-foreground text-sm",
            IDENTITY_BAR_BOX_CLASS,
            placement ? "max-w-96" : "max-w-xl",
          )}
        >
          {placement && dest ? (
            <span aria-hidden className="shrink-0 select-none whitespace-pre text-ink-subtle">
              {placementPrefix}
            </span>
          ) : null}
          <input
            ref={inputRef}
            className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-subtle/70"
            aria-label={t`Document name and location`}
            value={value}
            placeholder={placement ? ghost || location.leaf : undefined}
            spellCheck={false}
            disabled={saving}
            aria-invalid={Boolean(note)}
            onChange={(event) => {
              clearFeedback();
              setValue(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) => {
              setCaret(event.currentTarget.selectionStart ?? 0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") {
                event.preventDefault();
                onExit("escape");
              }
              // One action accepts the ghost into the field.
              if (
                placement &&
                !value &&
                (event.key === "Tab" || event.key === "ArrowRight") &&
                (ghost || location.leaf)
              ) {
                event.preventDefault();
                setValue(ghost || location.leaf);
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
      {/* Explicit commit/cancel affordances — additive mirrors of Enter and
          Esc. pointerdown is prevented so focus never leaves the input:
          otherwise the blur-revert contract would close the field before the
          click lands. Band-height boxes, so they never shift the chrome. */}
      <IconButton
        aria-label={t`Save name and location`}
        className="size-5.5"
        disabled={saving}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => void submit()}
      >
        <Check aria-hidden />
      </IconButton>
      <IconButton
        aria-label={t`Cancel editing`}
        className="size-5.5"
        disabled={saving}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => onExit("escape")}
      >
        <X aria-hidden />
      </IconButton>
      <PopoverContent
        data-file-suggestion
        align="start"
        className="max-h-64 w-80 overflow-y-auto p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <FileSuggestionList
          header={note}
          suggestions={placement ? placementRows : pathRows}
          onSelect={(entry) => {
            clearFeedback();
            if (placement) {
              if (entry.kind === "dir") {
                setDest(
                  entry.path === "/"
                    ? { scheme: entry.scheme, folderPath: "/" }
                    : { scheme: entry.scheme, folderPath: entry.path },
                );
                inputRef.current?.focus();
                return;
              }
              onOpenExisting(entry.scheme, entry.path);
              return;
            }
            completeSegment(entry.name);
          }}
          onClose={() => onExit("escape")}
          onNavigateUp={
            placement
              ? dest
                ? () =>
                    setDest(
                      dest.folderPath === "/"
                        ? null
                        : { scheme: dest.scheme, folderPath: parentFolderPath(dest.folderPath) },
                    )
                : undefined
              : undefined
          }
          hideParents
          emptyMessage={placement ? t`Nothing here yet` : t`No matching folders`}
        />
      </PopoverContent>
    </Popover>
  );

  /** Replace the caret's segment with a picked completion and append `/`. */
  function completeSegment(name: string) {
    const segment = segmentAtCaret(value, caret);
    const isLast = segment.index === value.split("/").length - 1;
    const replaced = `${value.slice(0, segment.start)}${name}${isLast ? "/" : ""}${value.slice(segment.end)}`;
    const nextCaret = segment.start + name.length + (isLast ? 1 : 0);
    setValue(replaced);
    setCaret(nextCaret);
    const input = inputRef.current;
    if (input) {
      input.focus();
      requestAnimationFrame(() => input.setSelectionRange(nextCaret, nextCaret));
    }
  }
}

function treeSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function pathModeReason(
  raw: string,
  roots: readonly ProjectContextTreeScheme[],
  rootLabels: readonly string[],
  entries: readonly AnnotatedFileSuggestion[],
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return t`Name is required`;
  const segments = trimmed.split("/");
  const canonicalRoot = matchRootLabel(segments[0] ?? "", roots);
  const canonical = canonicalRoot
    ? [
        schemeLabel(canonicalRoot),
        ...canonicalizeFolders(entries, canonicalRoot, segments.slice(1, -1)).canonical,
        ...segments.slice(-1),
      ].join("/")
    : trimmed;
  const reason = invalidContextEntryPathReason(canonical, rootLabels);
  if (reason) return reason;
  if (segments.length < 2) {
    return t`Include a location and a name, like Manuscript/chapter-1`;
  }
  return null;
}

function parseTypedPath(
  raw: string,
  roots: readonly ProjectContextTreeScheme[],
  entries: readonly AnnotatedFileSuggestion[],
): {
  scheme: ProjectContextTreeScheme;
  folders: string[];
  newFolders: string[];
  leaf: string;
} | null {
  const trimmed = raw.trim();
  const segments = trimmed.split("/");
  if (segments.length < 2) return null;
  const scheme = matchRootLabel(segments[0] ?? "", roots);
  if (!scheme) return null;
  const folderSegments = segments.slice(1, -1).map((segment) => segment.trim());
  const leaf = (segments[segments.length - 1] ?? "").trim();
  if (!leaf || folderSegments.some((segment) => !segment)) return null;
  if (invalidContextEntryNameReason(leaf)) return null;
  const { canonical, missing } = canonicalizeFolders(entries, scheme, folderSegments);
  if (canonical.some((segment) => invalidContextEntryNameReason(segment))) return null;
  return {
    scheme,
    folders: canonical,
    newFolders: missing.map((index) => canonical[index] ?? ""),
    leaf,
  };
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
