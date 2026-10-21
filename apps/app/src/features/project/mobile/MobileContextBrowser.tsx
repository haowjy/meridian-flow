/** Phone area navigation around the same nested catalog rows used by the desktop tree. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DeleteConfirmationDialog, useDeleteConfirmation } from "../context/ContextEntryActions";
import { TreeChildren, TreeEnvProvider } from "../context/ContextTreeRows";
import type { ContextCreateKind } from "../context/context-create-kind";
import { EDITOR_CONTEXT_SCHEMES, schemeIcon, schemeLabel } from "../context/context-schemes";
import { useOpenProjectDocument } from "../context/open-project-document";
import { treeFolderIds } from "../context/tree-expansion-state";
import { useTreeExpansion } from "../context/use-tree-expansion";
import type { ResolvedProjectViewProps } from "../ProjectView";

export type MobileContextBrowserProps = Pick<
  ResolvedProjectViewProps,
  | "projectId"
  | "editorWorkId"
  | "activeContextScheme"
  | "activeContextFolder"
  | "onSelectContextScheme"
  | "onSelectContextFolder"
  | "onSelectContextPath"
> & {
  creating: {
    kind: ContextCreateKind;
    scheme: ProjectContextTreeScheme;
    parentPath: string;
  } | null;
  onCreateDone: () => void;
};

export function MobileContextBrowser(props: MobileContextBrowserProps) {
  if (props.activeContextScheme)
    return (
      <MobileFolderTree
        key={`${props.projectId}:${props.activeContextScheme}:${props.editorWorkId}`}
        {...props}
        scheme={props.activeContextScheme}
      />
    );
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      {EDITOR_CONTEXT_SCHEMES.map((scheme) => {
        const Icon = schemeIcon(scheme);
        return (
          <button
            key={scheme}
            type="button"
            onClick={() => props.onSelectContextScheme(scheme)}
            className="focus-ring flex min-h-11 items-center gap-2.5 px-4 text-left text-sm text-foreground hover:bg-sidebar-accent/50"
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">{schemeLabel(scheme)}</span>
            <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

function MobileFolderTree({
  projectId,
  editorWorkId,
  scheme,
  activeContextFolder: folder,
  onSelectContextPath,
  creating,
  onCreateDone,
}: MobileContextBrowserProps & { scheme: ProjectContextTreeScheme }) {
  const { catalog, isComplete, isError, refetch } = useContextCatalogView(projectId, scheme, {
    workId: editorWorkId,
  });
  const deletion = useDeleteConfirmation({ projectId });
  const openDocument = useOpenProjectDocument(projectId);
  const [localCreate, setLocalCreate] = useState<{
    kind: ContextCreateKind;
    parentPath: string;
  } | null>(null);
  const pending = creating?.scheme === scheme ? creating : localCreate;
  const done = () => {
    setLocalCreate(null);
    onCreateDone();
  };
  const folderIds = useMemo(
    () =>
      catalog && isComplete
        ? treeFolderIds((id) =>
            catalog
              .children(id ?? catalog.root.entryId)
              .filter((node) => node.kind === "dir")
              .map((node) => node.entryId),
          )
        : null,
    [catalog, isComplete],
  );
  const { isExpanded, toggleEntry, setExpandedEntryIds } = useTreeExpansion(
    projectId,
    `editor:${scheme}:project`,
    folderIds,
  );
  useEffect(() => {
    if (!pending || !catalog) return;
    const parent = catalog.findPath(pending.parentPath);
    if (parent?.kind !== "dir") return;
    setExpandedEntryIds((entries) => {
      const expanded = { ...entries };
      let path = pending.parentPath;
      while (path && path !== "/") {
        const node = catalog.findPath(path);
        if (node?.kind === "dir") expanded[node.entryId] = true;
        path = path.replace(/\/[^/]+$/, "");
      }
      return expanded;
    });
  }, [catalog, pending, setExpandedEntryIds]);
  const current = folder ? catalog?.findPath(folder) : catalog?.root;
  const dir = current?.kind === "dir" ? current : null;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      {!catalog ? (
        isError ? (
          <InlineErrorRow message={t`Could not load files.`} onRetry={refetch} />
        ) : (
          <div aria-busy className="min-h-24" />
        )
      ) : !dir ? (
        <p className="p-4 text-sm text-muted-foreground">
          <Trans>This folder no longer exists.</Trans>
        </p>
      ) : (
        <TreeEnvProvider
          value={{
            projectId,
            owner: {},
            scheme,
            catalog,
            capabilities: ["rename", "move", "delete"],
            activeScheme: null,
            activePath: null,
            isExpanded,
            toggleEntry,
            onRequestDelete: deletion.requestDelete,
            creation: {
              creating: pending
                ? {
                    kind: pending.kind,
                    parentPath: pending.parentPath === "/" ? "" : pending.parentPath,
                  }
                : null,
              request: (kind, parentPath) => setLocalCreate({ kind, parentPath }),
              done,
              createdFile: (path) => onSelectContextPath(path, scheme),
            },
            onSelectFile: (_scheme, file) => {
              if (file.editable)
                void openDocument({
                  documentId: file.documentId,
                  workId: editorWorkId ?? undefined,
                });
              else onSelectContextPath(file.path, scheme);
            },
          }}
        >
          <TreeChildren
            parentId={dir.entryId}
            parentPath={dir.entryId === catalog.root.entryId ? "" : dir.path}
            depth={0}
          />
          {!pending && catalog.children(dir.entryId).length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              <Trans>This folder is empty.</Trans>
            </p>
          ) : null}
        </TreeEnvProvider>
      )}
      {catalog && isError ? (
        <InlineErrorRow message={t`Could not load files.`} onRetry={refetch} />
      ) : null}
      <DeleteConfirmationDialog
        target={deletion.target}
        isPending={deletion.isPending}
        error={deletion.error}
        onCancel={deletion.cancel}
        onConfirm={deletion.confirm}
      />
    </div>
  );
}
