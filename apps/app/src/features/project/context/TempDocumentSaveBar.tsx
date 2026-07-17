/**
 * TempDocumentSaveBar — ambient rename invitation for provisional documents.
 *
 * The URI-shaped field preserves location context, but v1 commits only the
 * basename. Enter renames; moving remains a tree action.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { renameContextEntryWithConflict } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { ContextTab } from "@/client/stores";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { cn } from "@/lib/utils";
import { invalidContextEntryNameReason } from "./context-entry-name";
import { FileSuggestionList, folderChildren, useFileSuggestions } from "./file-suggestions";
import { queueUntitledRename } from "./untitled-reconciler";
import { ValidationNote } from "./validation-note";

type RenameTab = Extract<ContextTab, { kind: "tracked" | "new" }>;

export function TempDocumentSaveBar({
  projectId,
  activeThreadId,
  tab,
  deviceOnly,
  onRenamed,
  onOpenExisting,
}: {
  projectId: string;
  activeThreadId: string | null;
  tab: RenameTab;
  deviceOnly: boolean;
  onRenamed: (name: string, path: string) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
}) {
  const tracked = tab.kind === "tracked" ? tab : null;
  const queryClient = useQueryClient();
  const parentPath = tracked ? tracked.path.slice(0, tracked.path.lastIndexOf("/")) || "/" : "/";
  const prefix = tracked
    ? `${tracked.scheme}://${tracked.workId ? `${tracked.workId}/` : ""}${parentPath
        .split("/")
        .filter(Boolean)
        .join("/")}${parentPath === "/" ? "" : "/"}`
    : "scratch://";
  const [draft, setDraft] = useState(`${prefix}${tab.name}`);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverConflict, setServerConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const options = useMemo(
    () => ({
      schemes: tracked ? [tracked.scheme] : ["scratch" as const],
      kinds: ["dir", "file"] as const,
      activeThreadId,
      workId: tracked?.workId,
    }),
    [activeThreadId, tracked?.scheme, tracked?.workId],
  );
  const { suggestions: allEntries } = useFileSuggestions(projectId, "", options);
  const entries = tracked ? folderChildren(allEntries, tracked.scheme, parentPath) : [];
  const name = draft.slice(draft.lastIndexOf("/") + 1).trim();
  const collision =
    entries.find((entry) => entry.name === name && entry.path !== tracked?.path) ?? null;
  const validation = name ? invalidContextEntryNameReason(name) : t`Name is required`;

  async function submit() {
    if (!name || validation || collision || name === tab.name || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (tab.kind === "new") {
        await queueUntitledRename(tab.documentId, name);
        return;
      }
      const result = await renameContextEntryWithConflict(
        projectId,
        tab.scheme,
        { path: tab.path, newName: name },
        tab.workId ? { workId: tab.workId } : undefined,
      );
      if (result.status === "conflict") {
        setServerConflict(true);
        setOpen(true);
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: projectQueryKeys.contextTree(projectId, tab.scheme, tab.workId),
      });
      onRenamed(name, replaceBasename(tab.path, name));
    } catch {
      setError(t`Couldn't rename this document. Try another name.`);
      setOpen(true);
    } finally {
      setSaving(false);
    }
  }

  const collisionPath =
    collision?.path ?? (tracked && serverConflict ? replaceBasename(tracked.path, name) : null);
  const collisionNote =
    collision || serverConflict ? (
      <ValidationNote
        severity={{
          level: "error",
          message: t`A file named ${name} already exists in this location.`,
        }}
        action={
          collision?.kind !== "dir" && collisionPath ? (
            <button
              data-file-suggestion
              type="button"
              tabIndex={-1}
              className="focus-ring ml-1.5 cursor-pointer font-medium underline underline-offset-2"
              onClick={() => tracked && onOpenExisting(tracked.scheme, collisionPath)}
            >
              <Trans>Open existing</Trans>
            </button>
          ) : undefined
        }
        className="m-1 mb-0"
      />
    ) : null;

  return (
    <section className={cn(editorColumnChrome, "@container py-2")} aria-label={t`Rename document`}>
      <div className="flex items-center gap-2">
        {deviceOnly ? <DeviceOnlyWarning /> : null}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverAnchor asChild>
            <Input
              ref={inputRef}
              className="h-8 min-w-0 max-w-96 flex-1"
              aria-label={t`Document name and location`}
              value={draft}
              spellCheck={false}
              aria-invalid={Boolean(validation || collision || error)}
              onFocus={() => setOpen(true)}
              onChange={(event) => {
                const nextName = event.target.value.slice(event.target.value.lastIndexOf("/") + 1);
                setDraft(`${prefix}${nextName}`);
                setError(null);
                setServerConflict(false);
                setOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
                if (event.key === "Escape") setOpen(false);
              }}
            />
          </PopoverAnchor>
          <PopoverContent
            align="start"
            className="max-h-64 overflow-y-auto p-0"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <FileSuggestionList
              header={collisionNote}
              suggestions={entries}
              onSelect={(entry) => {
                if (entry.kind === "file") onOpenExisting(tracked?.scheme ?? "scratch", entry.path);
              }}
              onClose={() => {
                setOpen(false);
                inputRef.current?.focus();
              }}
              hideParents
              emptyMessage={t`Nothing here yet`}
            />
          </PopoverContent>
        </Popover>
      </div>
      {saving ? (
        <p className="pt-1 text-right text-muted-foreground text-xs">
          <Trans>Renaming…</Trans>
        </p>
      ) : null}
      {error ? (
        <p className="pt-1 text-right text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

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

function replaceBasename(path: string, name: string): string {
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;
}
