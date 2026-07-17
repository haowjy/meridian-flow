/**
 * Move-to popup — the identity bar's pointing surface, anchored to the
 * "Choose a home" chip. The destination browser is the hero (anchored at the
 * document's current folder, drill-in/up through the scheme roots); the name
 * rides along below. One jade primary named for the act ("Move to Act 2" /
 * "Save name"), disabled when nothing changed.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
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
import { WRITABLE_IDENTITY_DESTINATIONS } from "./identity-destinations";
import { identityDestination, type TabLocation } from "./identity-location";
import type { IdentityCommitOutcome, IdentityCommitTarget } from "./use-identity-commit";
import { ValidationNote } from "./validation-note";

type Browse = { scheme: ProjectContextTreeScheme; folderPath: string } | null;

export function IdentityMovePopup({
  projectId,
  activeThreadId,
  defaultWorkId,
  location,
  open,
  onOpenChange,
  commit,
  onOpenExisting,
  trigger,
}: {
  projectId: string;
  activeThreadId: string | null;
  defaultWorkId: string | null;
  location: TabLocation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commit: (target: IdentityCommitTarget) => Promise<IdentityCommitOutcome>;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
  trigger: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* The trigger owns a Tooltip root, so anchoring it directly hands
          Radix a component that cannot forward the positioning ref to the
          button. A real wrapper keeps the popup attached to the visible chip
          instead of falling back to an off-screen floating-ui position. */}
      <PopoverAnchor asChild>
        <span className="inline-flex shrink-0">{trigger}</span>
      </PopoverAnchor>
      {open ? (
        <MovePopupContent
          key={`${location.scheme}:${location.path ?? ""}`}
          projectId={projectId}
          activeThreadId={activeThreadId}
          defaultWorkId={defaultWorkId}
          location={location}
          commit={commit}
          onOpenExisting={onOpenExisting}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Popover>
  );
}

function MovePopupContent({
  projectId,
  activeThreadId,
  defaultWorkId,
  location,
  commit,
  onOpenExisting,
  onClose,
}: {
  projectId: string;
  activeThreadId: string | null;
  defaultWorkId: string | null;
  location: TabLocation;
  commit: (target: IdentityCommitTarget) => Promise<IdentityCommitOutcome>;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
  onClose: () => void;
}) {
  const listRef = useRef<FileSuggestionListHandle>(null);
  // Anchored at the document's current folder; up-navigation climbs to the
  // scheme roots (the roots ARE the context choice).
  const [browse, setBrowse] = useState<Browse>({
    scheme: location.scheme,
    folderPath: location.parentPath,
  });
  const [name, setName] = useState(location.leaf);
  const [conflict, setConflict] = useState<{
    scheme: ProjectContextTreeScheme;
    path: string;
  } | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  const rows: AnnotatedFileSuggestion[] = browse
    ? folderChildren(allEntries, browse.scheme, browse.folderPath)
        .filter((entry) => entry.kind === "dir")
        .map((entry) =>
          entry.scheme === location.scheme && entry.path === location.parentPath
            ? { ...entry, hint: t`current home` }
            : entry,
        )
    : WRITABLE_IDENTITY_DESTINATIONS.map((scheme) => ({
        scheme,
        path: "/",
        name: schemeLabel(scheme),
        kind: "dir" as const,
        parents: [],
        ...(scheme === location.scheme && location.parentPath === "/"
          ? { hint: t`current home` }
          : {}),
      }));

  const trimmed = name.trim();
  const nameChanged = trimmed !== location.leaf;
  const destinationChanged = Boolean(
    browse && !(browse.scheme === location.scheme && browse.folderPath === location.parentPath),
  );
  const nameReason = trimmed ? invalidContextEntryNameReason(trimmed) : t`Name is required`;
  const destinationName = browse
    ? browse.folderPath === "/"
      ? schemeLabel(browse.scheme)
      : browse.folderPath.slice(browse.folderPath.lastIndexOf("/") + 1)
    : "";
  const canCommit = (destinationChanged || nameChanged) && !nameReason && !saving;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => listRef.current?.focusFirst());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  async function run(target: IdentityCommitTarget) {
    setSaving(true);
    setRequestError(null);
    setConflict(null);
    try {
      const outcome = await commit(target);
      if (outcome.status === "conflict") {
        setConflict({ scheme: outcome.locator.scheme, path: outcome.locator.path });
        return;
      }
      if (outcome.status === "error") {
        setRequestError(outcome.message);
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <PopoverContent
      data-file-suggestion
      align="end"
      className="w-80 p-0"
      onOpenAutoFocus={(event) => event.preventDefault()}
    >
      <p className="px-3 pt-2.5 pb-1 font-medium text-ink-subtle text-meta">
        <Trans>Where should this live?</Trans>
      </p>
      <div className="max-h-56 overflow-y-auto">
        <FileSuggestionList
          ref={listRef}
          suggestions={rows}
          onSelect={(entry) => {
            setConflict(null);
            setBrowse(
              entry.path === "/"
                ? { scheme: entry.scheme, folderPath: "/" }
                : { scheme: entry.scheme, folderPath: entry.path },
            );
          }}
          onClose={onClose}
          onNavigateUp={
            browse
              ? () =>
                  setBrowse(
                    browse.folderPath === "/"
                      ? null
                      : { scheme: browse.scheme, folderPath: parentFolderPath(browse.folderPath) },
                  )
              : undefined
          }
          hideParents
          emptyMessage={t`No folders here`}
        />
      </div>
      {conflict ? (
        <ValidationNote
          severity={{
            level: "error",
            message: t`A file named ${conflict.path.slice(conflict.path.lastIndexOf("/") + 1)} already exists in this location.`,
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
          className="mx-3 mt-1"
        />
      ) : requestError ? (
        <ValidationNote
          severity={{ level: "error", message: requestError }}
          className="mx-3 mt-1"
        />
      ) : null}
      <div className="mt-1 flex items-center gap-2 border-border border-t px-3 pt-2">
        <label className="text-ink-subtle text-meta" htmlFor="identity-move-name">
          <Trans>Name</Trans>
        </label>
        <input
          id="identity-move-name"
          className="focus-ring min-w-0 flex-1 rounded-sm border border-border bg-card px-1.5 py-0.5 text-foreground text-xs"
          value={name}
          spellCheck={false}
          aria-invalid={Boolean(nameReason && trimmed)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setConflict(null);
            setRequestError(null);
            setName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canCommit) {
              void run({
                destination: identityDestination(location, defaultWorkId, browse ?? undefined),
                name: trimmed,
              });
            }
          }}
        />
      </div>
      <div className="flex justify-end gap-2 px-3 py-2.5">
        {location.scheme === "scratch" ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              if ((location.provisional || nameChanged) && !nameReason) {
                void run({
                  destination: identityDestination(location, defaultWorkId),
                  name: trimmed || location.leaf,
                });
                return;
              }
              onClose();
            }}
          >
            <Trans>Keep in Scratch</Trans>
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={!canCommit}
          onClick={() =>
            void run({
              destination: identityDestination(location, defaultWorkId, browse ?? undefined),
              name: trimmed,
            })
          }
        >
          {destinationChanged ? <Trans>Move to {destinationName}</Trans> : <Trans>Save name</Trans>}
        </Button>
      </div>
    </PopoverContent>
  );
}
