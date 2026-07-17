/**
 * UntitledRenameLine — ambient rename invitation for provisional documents.
 *
 * The URI-shaped field preserves location context, but v1 commits only the
 * basename. Enter renames; moving remains a tree action.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";

import { renameContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { ContextTab } from "@/client/stores";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { cn } from "@/lib/utils";
import { invalidContextEntryNameReason } from "./context-entry-name";
import {
  FileSuggestionList,
  folderChildren,
  parentPath as parentFolderPath,
  useFileSuggestions,
} from "./file-suggestions";
import { suggestedUntitledDocumentName } from "./untitled-document-name";
import { queueUntitledRename } from "./untitled-reconciler";
import { ValidationNote } from "./validation-note";

type RenameTab = Extract<ContextTab, { kind: "tracked" | "new" }>;

export function UntitledRenameLine({
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
  const suggestionFragment = useMemo(() => {
    const session = getDocumentSessionRegistry().getDetached(tab.documentId);
    return session.document.getXmlFragment(session.fragmentName);
  }, [tab.documentId]);
  const [draft, setDraft] = useState(
    () => `${prefix}${suggestedUntitledName(tab, suggestionFragment) || tab.name}`,
  );
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState(parentPath);
  const [error, setError] = useState<string | null>(null);
  const [serverConflict, setServerConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const writerOwnsName = useRef(false);

  useEffect(() => {
    let timer: number | null = null;
    const refreshSuggestion = () => {
      if (writerOwnsName.current) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const suggestion = suggestedUntitledName(tab, suggestionFragment);
        if (suggestion) setDraft(`${prefix}${suggestion}`);
      }, 300);
    };
    suggestionFragment.observeDeep(refreshSuggestion);
    refreshSuggestion();
    return () => {
      suggestionFragment.unobserveDeep(refreshSuggestion);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [prefix, suggestionFragment, tab]);
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
  const currentEntries = tracked ? folderChildren(allEntries, tracked.scheme, parentPath) : [];
  const entries = tracked ? folderChildren(allEntries, tracked.scheme, browsePath) : [];
  const name = draft.slice(draft.lastIndexOf("/") + 1).trim();
  const collision =
    currentEntries.find((entry) => entry.name === name && entry.path !== tracked?.path) ?? null;
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
      const result = await renameContextEntry(
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
                writerOwnsName.current = true;
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
                if (entry.kind === "dir") {
                  setBrowsePath(entry.path);
                  return;
                }
                onOpenExisting(tracked?.scheme ?? "scratch", entry.path);
              }}
              onClose={() => {
                setOpen(false);
                inputRef.current?.focus();
              }}
              onNavigateUp={
                browsePath === "/" ? undefined : () => setBrowsePath(parentFolderPath(browsePath))
              }
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
      <p className="inline-flex h-8 min-w-0 items-center gap-1 rounded-md border border-warning-border bg-warning-bg px-2.5 font-medium text-warning-foreground text-xs @max-md:hidden">
        <TriangleAlert aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </p>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={label}
            className="hidden size-8 items-center justify-center rounded-md border border-warning-border bg-warning-bg text-warning-foreground @max-md:inline-flex"
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

function suggestedUntitledName(tab: RenameTab, fragment: Y.XmlFragment): string {
  const text = firstXmlBlockText(fragment);
  if (!text) return "";
  const suggestion = suggestedUntitledDocumentName({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  if (!suggestion || tab.kind === "new") return suggestion;
  const extensionIndex = tab.name.lastIndexOf(".");
  const extension = extensionIndex > 0 ? tab.name.slice(extensionIndex) : "";
  return extension && !suggestion.endsWith(extension) ? `${suggestion}${extension}` : suggestion;
}

function firstXmlBlockText(fragment: Y.XmlFragment): string {
  const firstElement = fragment.toArray().find((child) => child instanceof Y.XmlElement);
  return firstElement instanceof Y.XmlElement ? xmlTextContent(firstElement).trim() : "";
}

function xmlTextContent(node: Y.XmlElement): string {
  let text = "";
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      text += child.toString();
    }
    if (child instanceof Y.XmlElement) {
      text += xmlTextContent(child);
    }
  }
  return text;
}
