/**
 * Inline document identity editor for placement, rename, and move.
 *
 * Provisional documents open empty with a content-derived ghost name; settled
 * documents open with their current name selected. Picking folders builds a
 * read-only destination prefix. Enter or Save commits through one identity
 * seam; Esc, Cancel, focus leaving the field, or opening an existing file revert it.
 */

import { t } from "@lingui/core/macro";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Check, X } from "lucide-react";
import { type FocusEvent, useEffect, useMemo, useRef, useState } from "react";

import type { OpenDocument } from "@/client/stores";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { documentRow, entryNameStemEnd } from "./context-entry-name";
import { areaOf, schemeLabel } from "./context-schemes";
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
import { suggestedNameFromDocument } from "./untitled-document-name";
import type { IdentityCommitOutcome, IdentityCommitTarget } from "./use-identity-commit";
import { useLiveDocumentBinding } from "./use-live-document-binding";
import { ValidationNote } from "./validation-note";

type ExitReason = "escape" | "blur" | "commit";

type IdentityNote = { kind: "error"; message: string } | null;

export function IdentityPlacementField({
  projectId,
  editorWorkId,
  document,
  location,
  commit,
  onExit,
  onOpenExisting,
}: {
  projectId: string;
  editorWorkId: string | null;
  document: OpenDocument;
  location: TabLocation;
  commit: (target: IdentityCommitTarget) => Promise<IdentityCommitOutcome>;
  onExit: (reason: ExitReason) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string, owner: ContextOwner) => void;
}) {
  const localSessionRef = useRef<import("@/core/editor/document-session").DocumentSession | null>(
    null,
  );
  const provisionalPlacement =
    location.provisional && location.scheme === "unfiled" && location.parentPath === "/";
  const binding = useLiveDocumentBinding({
    projectId,
    documentId: provisionalPlacement && document.kind !== "viewer" ? document.documentId : null,
    owner: "desktop-document-host",
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<FileSuggestionListHandle>(null);
  const suggestionTimer = useRef<number | null>(null);
  const [destination, setDestination] = useState<{
    scheme: ProjectContextTreeScheme;
    folderPath: string;
    parentId?: string;
  } | null>(null);
  const [value, setValue] = useState(() => (provisionalPlacement ? "" : location.leaf));
  const [ghost, setGhost] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [commitReason, setCommitReason] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    // Only the part before a visible extension: `outline` in `outline.json`.
    if (input?.value)
      input.setSelectionRange(0, entryNameStemEnd(input.value, documentRow(location.leaf)));
  }, []);

  useEffect(() => {
    if (!provisionalPlacement || document.kind === "viewer") return;
    const session = binding.state.kind === "opened" ? binding.state.session : null;
    if (!session) return;
    localSessionRef.current = session;
    const refresh = () => {
      if (suggestionTimer.current !== null) window.clearTimeout(suggestionTimer.current);
      suggestionTimer.current = window.setTimeout(() => {
        suggestionTimer.current = null;
        setGhost(suggestionForSession(document, session));
      }, 300);
    };
    const stop = session.subscribeContent(refresh);
    refresh();
    return () => {
      stop();
      if (suggestionTimer.current !== null) window.clearTimeout(suggestionTimer.current);
    };
  }, [binding.state, provisionalPlacement, document]);

  // The document's own owner scopes its Scratch suggestions, collisions and "Open
  // existing"; the Editor's selected Work does not (a chat's Scratch has none).
  const { workId: locationWorkId, rootThreadId, rootThreadRef } = location;
  const owner = useMemo<ContextOwner>(
    () =>
      rootThreadId !== undefined
        ? { rootThreadId, rootThreadRef }
        : { workId: locationWorkId ?? editorWorkId },
    [editorWorkId, locationWorkId, rootThreadId, rootThreadRef],
  );
  const ownerOfScheme = (scheme: ProjectContextTreeScheme): ContextOwner =>
    isWorkScopedScheme(scheme) ? owner : { workId: null };
  // Filing moves the document, so it offers the places in its own list: the project's files, or
  // the account's Your files.
  const inAccount = location.scheme === "user";
  const destinations = useMemo(
    () => WRITABLE_IDENTITY_DESTINATIONS.filter((scheme) => (scheme === "user") === inAccount),
    [inAccount],
  );
  const allEntries = useFileSuggestions(
    projectId,
    [...new Set([...destinations, location.scheme])],
    owner,
  );
  const rootRows: AnnotatedFileSuggestion[] = useMemo(
    () =>
      destinations.map((scheme) => ({
        entryId: `root:${scheme}`,
        scheme,
        path: "/",
        name: schemeLabel(scheme),
        kind: "dir" as const,
        parents: [],
      })),
    [destinations],
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
    ? `${placementPrefix(destination.scheme, destination.folderPath)}/`
    : "";

  const identityNote = deriveIdentityNote({
    validationReason: commitReason,
    requestError,
  });
  const note =
    identityNote?.kind === "error" ? (
      <ValidationNote severity={{ level: "error", message: identityNote.message }} />
    ) : null;

  async function submit() {
    if (saving) return;
    setCommitReason(null);
    const name = value.trim() || ghost || location.leaf;
    if (!name) {
      setCommitReason(t`Name is required`);
      return;
    }
    await runCommit({
      destination: identityDestination(location, editorWorkId, destination ?? undefined),
      name,
    });
  }

  async function runCommit(target: IdentityCommitTarget) {
    setSaving(true);
    setRequestError(null);
    try {
      const outcome = await commit(target);
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
    setRequestError(null);
    setCommitReason(null);
  };

  // Focus moving among the input, Save, Cancel and the suggestions keeps the field open, so Tab
  // reaches Save and Cancel; leaving all of them reverts.
  const exitOnLeave = (event: FocusEvent<HTMLElement>) => {
    if (saving) return;
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    if (next instanceof HTMLElement && next.closest("[data-file-suggestion]")) return;
    onExit("blur");
  };

  return (
    <fieldset aria-label={t`Name and location`} className="contents" onBlur={exitOnLeave}>
      <Popover open>
        <PopoverAnchor asChild>
          <div
            className={cn(
              "flex min-w-0 max-w-96 flex-1 items-center rounded-sm border border-primary bg-card px-1.5 font-sans text-foreground text-sm",
              IDENTITY_BAR_BOX_CLASS,
            )}
          >
            {destination ? (
              <span
                aria-hidden
                className="shrink-0 select-none whitespace-pre text-muted-foreground"
              >
                {prefix}
              </span>
            ) : null}
            <input
              ref={inputRef}
              className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
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
                // Back out the way the writer came in: the prose, not the toolbar before the field.
                if (event.key === "Tab" && event.shiftKey) {
                  event.preventDefault();
                  onExit("escape");
                  return;
                }
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
            />
          </div>
        </PopoverAnchor>
        <IconButton
          label={t`Save name and location`}
          disabled={saving}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void submit()}
        >
          <Check aria-hidden />
        </IconButton>
        <IconButton
          label={t`Cancel editing`}
          disabled={saving}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onExit("escape")}
        >
          <X aria-hidden />
        </IconButton>
        <PopoverContent
          data-file-suggestion
          align="start"
          className={dropdownSurfaceVariants({ measure: "catalog" })}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <FileSuggestionList
            ref={listRef}
            header={note}
            suggestions={rows}
            onSelect={(entry) => {
              clearFeedback();
              if (entry.kind === "dir") {
                setDestination({
                  scheme: entry.scheme,
                  folderPath: entry.path,
                  ...(entry.path === "/" ? {} : { parentId: entry.entryId }),
                });
                inputRef.current?.focus();
                return;
              }
              onOpenExisting(entry.scheme, entry.path, ownerOfScheme(entry.scheme));
              onExit("blur");
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
    </fieldset>
  );
}

function deriveIdentityNote({
  validationReason,
  requestError,
}: {
  validationReason: string | null;
  requestError: string | null;
}): IdentityNote {
  if (validationReason) return { kind: "error", message: validationReason };
  if (requestError) return { kind: "error", message: requestError };
  return null;
}

function treeSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function suggestionForSession(
  tab: OpenDocument,
  session: import("@/core/editor/document-session").DocumentSession,
): string {
  const suggestion = suggestedNameFromDocument(session.docs);
  if (!suggestion || tab.kind === "new") return suggestion;
  // The suggestion carries the file's visible extension (`.json`); a prose name has none.
  const extension = tab.name.slice(entryNameStemEnd(tab.name, documentRow(tab.name)));
  return extension && !suggestion.endsWith(extension) ? `${suggestion}${extension}` : suggestion;
}

/** "Manuscript/Arc 3", "~/.agents/agents": where a placed document goes, area first. */
function placementPrefix(scheme: ProjectContextTreeScheme, folderPath: string): string {
  const { area, rest } = areaOf(scheme, folderPath);
  return [area, ...treeSegments(rest)].join("/");
}
