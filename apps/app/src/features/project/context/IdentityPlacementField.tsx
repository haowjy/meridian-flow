/**
 * Inline document identity editor for placement, rename, and move.
 *
 * Provisional documents open empty with a content-derived ghost name; settled
 * documents open with their current name selected. Picking folders builds a
 * read-only destination prefix. Enter or Save commits through one identity
 * seam; Esc, blur, or Cancel revert it.
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
import { invalidContextEntryNameReason } from "./context-entry-name";
import { schemeLabel } from "./context-schemes";
import {
  type AnnotatedFileSuggestion,
  FileSuggestionList,
  type FileSuggestionListHandle,
  folderChildren,
  parentPath as parentFolderPath,
  useFileSuggestions,
} from "./file-suggestions";
import { IDENTITY_BAR_BOX_CLASS } from "./identity-bar-geometry";
import { WRITABLE_IDENTITY_DESTINATIONS } from "./identity-destinations";
import { identityDestination, type TabLocation } from "./identity-location";
import { suggestedNameFromFragment } from "./untitled-document-name";
import type { QueuedIdentityFailure } from "./untitled-reconciler";
import { clearQueuedIdentityFailure } from "./untitled-reconciler-browser";
import type { IdentityCommitOutcome, IdentityCommitTarget } from "./use-identity-commit";
import { ValidationNote } from "./validation-note";

type ExitReason = "escape" | "blur" | "commit";
type ConflictLocator = { scheme: ProjectContextTreeScheme; path: string; workId?: string };
type LocalCollision = AnnotatedFileSuggestion | null;

type IdentityNote =
  | { kind: "conflict"; locator: ConflictLocator; name: string }
  | { kind: "local-collision"; collision: AnnotatedFileSuggestion; name: string }
  | { kind: "error"; message: string }
  | null;

export function IdentityPlacementField({
  projectId,
  activeThreadId,
  defaultWorkId,
  tab,
  location,
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
  failure: QueuedIdentityFailure | null;
  commit: (target: IdentityCommitTarget) => Promise<IdentityCommitOutcome>;
  onExit: (reason: ExitReason) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
}) {
  const provisionalPlacement =
    location.provisional && location.scheme === "scratch" && location.parentPath === "/";
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<FileSuggestionListHandle>(null);
  const suggestionTimer = useRef<number | null>(null);
  const [destination, setDestination] = useState<{
    scheme: ProjectContextTreeScheme;
    folderPath: string;
  } | null>(null);
  const [value, setValue] = useState(
    () => failure?.name ?? (provisionalPlacement ? "" : location.leaf),
  );
  const [ghost, setGhost] = useState(() => (provisionalPlacement ? suggestionForTab(tab) : ""));
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

  useEffect(() => {
    const timer = window.setTimeout(() => setNoteValue(value), 300);
    return () => window.clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    if (input?.value) input.select();
  }, []);

  useEffect(() => {
    if (!provisionalPlacement) return;
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
      if (suggestionTimer.current !== null) window.clearTimeout(suggestionTimer.current);
    };
  }, [provisionalPlacement, tab]);

  const suggestionOptions = useMemo(
    () => ({
      schemes: [...new Set([...WRITABLE_IDENTITY_DESTINATIONS, location.scheme])],
      kinds: ["dir", "file"] as const,
      activeThreadId,
      workId: defaultWorkId ?? location.workId,
    }),
    [activeThreadId, defaultWorkId, location.scheme, location.workId],
  );
  const { suggestions: allEntries } = useFileSuggestions(projectId, "", suggestionOptions);
  const rootRows: AnnotatedFileSuggestion[] = useMemo(
    () =>
      WRITABLE_IDENTITY_DESTINATIONS.map((scheme) => ({
        scheme,
        path: "/",
        name: schemeLabel(scheme),
        kind: "dir" as const,
        parents: [],
      })),
    [],
  );
  const rows = destination
    ? folderChildren(allEntries, destination.scheme, destination.folderPath)
    : provisionalPlacement
      ? rootRows
      : [
          ...folderChildren(allEntries, location.scheme, location.parentPath).filter(
            (entry) => entry.path !== location.path,
          ),
          ...rootRows,
        ];
  const prefix = destination
    ? `${[schemeLabel(destination.scheme), ...treeSegments(destination.folderPath)].join("/")}/`
    : "";

  const liveReason = noteValue.trim() ? invalidContextEntryNameReason(noteValue.trim()) : null;
  const localCollision = useMemo(
    () =>
      findCollision(
        allEntries,
        destination?.scheme ?? location.scheme,
        destination?.folderPath ?? location.parentPath,
        noteValue.trim(),
        location.path,
      ),
    [allEntries, destination, location, noteValue],
  );
  const identityNote = deriveIdentityNote({
    conflict,
    localCollision,
    name: noteValue.trim(),
    validationReason: commitReason ?? liveReason,
    requestError,
  });
  const note =
    identityNote?.kind === "conflict" ? (
      <ValidationNote
        severity={{
          level: "error",
          message: t`A file named ${identityNote.name} already exists in this location.`,
        }}
        action={
          <button
            data-file-suggestion
            type="button"
            tabIndex={-1}
            className="focus-ring ml-1.5 cursor-pointer font-medium underline underline-offset-2"
            onClick={() => onOpenExisting(identityNote.locator.scheme, identityNote.locator.path)}
          >
            <Trans>Open existing</Trans>
          </button>
        }
        className="m-1 mb-0"
      />
    ) : identityNote?.kind === "local-collision" ? (
      <ValidationNote
        severity={{
          level: "error",
          message:
            identityNote.collision.kind === "dir"
              ? t`A folder named ${identityNote.name} already exists in this location.`
              : t`A file named ${identityNote.name} already exists in this location.`,
        }}
        action={
          identityNote.collision.kind !== "dir" ? (
            <button
              data-file-suggestion
              type="button"
              tabIndex={-1}
              className="focus-ring ml-1.5 cursor-pointer font-medium underline underline-offset-2"
              onClick={() =>
                onOpenExisting(identityNote.collision.scheme, identityNote.collision.path)
              }
            >
              <Trans>Open existing</Trans>
            </button>
          ) : undefined
        }
        className="m-1 mb-0"
      />
    ) : identityNote?.kind === "error" ? (
      <ValidationNote
        severity={{ level: "error", message: identityNote.message }}
        className="m-1 mb-0"
      />
    ) : null;

  async function submit() {
    if (saving) return;
    setCommitReason(null);
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
    if (
      findCollision(
        allEntries,
        destination?.scheme ?? location.scheme,
        destination?.folderPath ?? location.parentPath,
        name,
        location.path,
      )
    ) {
      setNoteValue(value || name);
      return;
    }
    await runCommit({
      destination: identityDestination(location, defaultWorkId, destination ?? undefined),
      name,
    });
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
    clearQueuedIdentityFailure(tab.documentId);
  };

  return (
    <Popover open>
      <PopoverAnchor asChild>
        <div
          className={cn(
            "flex min-w-0 max-w-96 flex-1 items-center rounded-sm border border-primary bg-card px-1.5 font-sans text-foreground text-sm",
            IDENTITY_BAR_BOX_CLASS,
          )}
        >
          {destination ? (
            <span aria-hidden className="shrink-0 select-none whitespace-pre text-ink-subtle">
              {prefix}
            </span>
          ) : null}
          <input
            ref={inputRef}
            className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-subtle/70"
            aria-label={t`Document name and location`}
            value={value}
            placeholder={ghost || location.leaf}
            spellCheck={false}
            disabled={saving}
            aria-invalid={Boolean(note)}
            onChange={(event) => {
              clearFeedback();
              setValue(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (event.key === "ArrowDown") listRef.current?.focusFirst();
                else listRef.current?.focusLast();
                return;
              }
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") {
                event.preventDefault();
                onExit("escape");
              }
              if (
                !value &&
                (event.key === "Tab" || event.key === "ArrowRight") &&
                (ghost || location.leaf)
              ) {
                event.preventDefault();
                const accepted = ghost || location.leaf;
                setValue(accepted);
                window.requestAnimationFrame(() => {
                  inputRef.current?.focus();
                  inputRef.current?.setSelectionRange(accepted.length, accepted.length);
                });
              }
            }}
            onBlur={(event) => {
              if (saving) return;
              const next = event.relatedTarget as HTMLElement | null;
              if (next?.closest("[data-file-suggestion]")) return;
              onExit("blur");
            }}
          />
        </div>
      </PopoverAnchor>
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
          ref={listRef}
          header={note}
          suggestions={rows}
          onSelect={(entry) => {
            clearFeedback();
            if (entry.kind === "dir") {
              setDestination({ scheme: entry.scheme, folderPath: entry.path });
              inputRef.current?.focus();
              return;
            }
            onOpenExisting(entry.scheme, entry.path);
          }}
          onClose={() => onExit("escape")}
          onNavigateUp={
            destination
              ? () =>
                  setDestination(
                    destination.folderPath === "/"
                      ? null
                      : {
                          scheme: destination.scheme,
                          folderPath: parentFolderPath(destination.folderPath),
                        },
                  )
              : undefined
          }
          hideParents
          emptyMessage={t`Nothing here yet`}
        />
      </PopoverContent>
    </Popover>
  );
}

function findCollision(
  entries: readonly AnnotatedFileSuggestion[],
  scheme: ProjectContextTreeScheme,
  folderPath: string,
  name: string,
  currentPath: string | null,
): LocalCollision {
  if (!name) return null;
  return (
    folderChildren(entries, scheme, folderPath).find(
      (entry) => entry.name === name && entry.path !== currentPath,
    ) ?? null
  );
}

function deriveIdentityNote({
  conflict,
  localCollision,
  name,
  validationReason,
  requestError,
}: {
  conflict: ConflictLocator | null;
  localCollision: LocalCollision;
  name: string;
  validationReason: string | null;
  requestError: string | null;
}): IdentityNote {
  if (conflict) {
    return {
      kind: "conflict",
      locator: conflict,
      name: conflict.path.slice(conflict.path.lastIndexOf("/") + 1),
    };
  }
  if (localCollision) return { kind: "local-collision", collision: localCollision, name };
  if (validationReason) return { kind: "error", message: validationReason };
  if (requestError) return { kind: "error", message: requestError };
  return null;
}

function treeSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
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
