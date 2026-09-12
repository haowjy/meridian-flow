/** Project document tree. Chat resources have no ordinary Editor tabs or sidebar sections. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { FilePlus, FolderPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DeleteConfirmationDialog, useDeleteConfirmation } from "./ContextEntryActions";
import { TreeChildren, type TreeEnv, TreeEnvProvider } from "./ContextTreeRows";
import type { ContextCreateKind } from "./context-create-kind";
import {
  EDITOR_CONTEXT_SCHEMES,
  schemeAllowsCreation,
  schemeIcon,
  schemeLabel,
} from "./context-schemes";
import type { LocalUntitledWorkSnapshot } from "./local-untitled-owner";
import { PaneHeaderActionButton, RailPaneHeader } from "./RailPaneHeader";
import { type TreeCreationRequest, useOptionalTreeCreation } from "./TreeCreationProvider";
import { UnfiledPendingDocuments } from "./UnfiledPendingDocuments";
import { usePendingUnfiledDocuments } from "./untitled-reconciler-browser";

/** Left pad (px) for a row at `depth` — depth 1 = a section's direct child. */
function rowPaddingLeft(depth: number): number {
  return 8 + depth * 16;
}

export type ContextTreePanelProps = {
  projectId: string;
  /** Shell-resolved Editor Work; the tree never derives scope from Chat. */
  editorWorkId: string | null;
  /** Scheme of the currently active file (drives section auto-expand). */
  activeScheme: ProjectContextTreeScheme | null;
  /** Path of the currently active file inside `activeScheme`'s tree. */
  activePath: string | null;
  /** Called when the user picks a file row in any scheme section. */
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  creating?: TreeCreationRequest | null;
  onRequestCreate?: (request: TreeCreationRequest) => void;
  onCreateDone?: () => void;
};

/**
 * VS Code-style multi-scheme file tree. Each context scheme renders as a
 * collapsible top-level section with hover "New file / New folder" actions.
 * Every section's tree query runs from rail mount — collapsed panes just
 * don't render the data yet — so the first expand after a reload paints from
 * cache instead of flashing a load. A selection landing in a section
 * auto-opens it once; after that the user's toggle wins, even while the
 * section holds the active doc.
 */
export function ContextTreePanel({
  projectId,
  editorWorkId,
  activeScheme,
  activePath,
  onSelectFile,
  creating: controlledCreating,
  onRequestCreate: controlledRequestCreate,
  onCreateDone: controlledCreateDone,
}: ContextTreePanelProps) {
  const controller = useOptionalTreeCreation();
  const creating = controlledCreating ?? controller?.request ?? null;
  const onRequestCreate = controlledRequestCreate ?? controller?.requestCreate;
  const onCreateDone = controlledCreateDone ?? controller?.completeCreate;
  if (!onRequestCreate || !onCreateDone) {
    throw new Error("ContextTreePanel requires creation controls");
  }
  const pending = usePendingUnfiledDocuments(projectId);
  const schemes = EDITOR_CONTEXT_SCHEMES;
  const renderScheme = (scheme: ProjectContextTreeScheme) => (
    <SchemeSection
      key={scheme}
      projectId={projectId}
      editorWorkId={editorWorkId}
      scheme={scheme}
      activeScheme={activeScheme}
      activePath={activePath}
      defaultExpanded={scheme === schemes[0]}
      pending={scheme === "unfiled" ? pending : []}
      onSelectFile={onSelectFile}
      creating={
        creating?.scheme === scheme && creating.workId === editorWorkId
          ? { kind: creating.kind, parentPath: creating.parentPath }
          : null
      }
      onRequestCreate={(kind, parentPath) =>
        onRequestCreate({ scheme, kind, parentPath, workId: editorWorkId })
      }
      onCreateDone={onCreateDone}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* The destination rows own the sidebar's single rule. Explorer panes
          stay on one uninterrupted rail material beneath it. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2">
        {schemes.map(renderScheme)}
      </div>
    </div>
  );
}

function SchemeSection({
  projectId,
  editorWorkId,
  scheme,
  activeScheme,
  activePath,
  defaultExpanded,
  pending,
  onSelectFile,
  creating,
  onRequestCreate,
  onCreateDone,
}: {
  projectId: string;
  editorWorkId: string | null;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  defaultExpanded: boolean;
  pending: readonly LocalUntitledWorkSnapshot[];
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  creating: { kind: ContextCreateKind; parentPath: string } | null;
  onRequestCreate: (kind: ContextCreateKind, parentPath: string) => void;
  onCreateDone: () => void;
}) {
  // `expanded` is the pane's only open state. Holding the active doc must
  // NOT keep a pane open (Jimmy: "we should still be able to collapse"):
  // selection and creation changes below expand it as one-shot events, so a
  // later user collapse sticks until the user reopens it or a new selection
  // lands inside.
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [expandedEntryIds, setExpandedEntryIds] = useState<Record<string, boolean>>({});
  const activeLocationPath = activeScheme === scheme ? activePath : null;
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(null);
  const { catalog, isError, refetch } = useContextCatalogView(projectId, scheme, {
    workId: editorWorkId,
  });

  const pendingUnfiled =
    scheme === "unfiled"
      ? pending.filter(
          (record) => !catalog?.files().some((file) => file.documentId === record.key.documentId),
        )
      : [];

  const revealPath = useCallback(
    (path: string) => {
      if (!catalog) return;
      const segments = path.split("/").filter(Boolean);
      if (segments.length === 0) return;
      setExpandedEntryIds((current) => {
        const next = { ...current };
        let ancestor = "";
        for (const segment of segments) {
          ancestor += `/${segment}`;
          const entry = catalog.findPath(ancestor);
          if (entry?.kind === "dir") next[entry.entryId] = true;
        }
        return next;
      });
    },
    [catalog],
  );

  useEffect(() => {
    if (!activeLocationPath) return;
    setExpanded(true);
    revealPath(parentContextPath(activeLocationPath));
  }, [activeLocationPath, revealPath]);

  useEffect(() => {
    if (!creating) return;
    setExpanded(true);
    revealPath(creating.parentPath);
  }, [creating, revealPath]);

  const requestCreate = useCallback(
    (kind: ContextCreateKind, parentPath: string) => {
      setExpanded(true);
      revealPath(parentPath);
      onRequestCreate(kind, parentPath);
    },
    [onRequestCreate, revealPath],
  );

  const toggleEntry = useCallback((entryId: string, defaultOpen: boolean) => {
    setExpandedEntryIds((current) => ({
      ...current,
      [entryId]: !(current[entryId] ?? defaultOpen),
    }));
  }, []);

  // The query is unconditionally enabled: it prefetches at rail mount so the
  // first expand paints from cache (work-scoped schemes still wait for their
  // workId inside the hook). `pendingOpenPath` waits on the same always-live
  // query so a just-created file can resolve and open; its onSelectFile then
  // lands a new selection here, which re-expands via the effect above.
  useEffect(() => {
    if (!pendingOpenPath || !catalog) return;
    const entry = catalog.findPath(pendingOpenPath);
    if (entry?.kind !== "file") return;
    const file = entry;
    onSelectFile(scheme, file);
    setPendingOpenPath(null);
  }, [pendingOpenPath, catalog, onSelectFile, scheme]);

  const deleteConfirm = useDeleteConfirmation({ projectId, workId: editorWorkId, scheme });
  const env = useMemo<TreeEnv | null>(
    () =>
      catalog
        ? ({
            projectId,
            workId: editorWorkId,
            scheme,
            activeScheme,
            activePath,
            creating,
            onSelectFile,
            onRequestCreate: requestCreate,
            onRequestDelete: deleteConfirm.requestDelete,
            onCreateDone,
            onCreatedFilePath: setPendingOpenPath,
            catalog,
            isExpanded: (entryId, depth) => expandedEntryIds[entryId] ?? depth < 2,
            toggleEntry,
          } satisfies TreeEnv)
        : null,
    [
      projectId,
      editorWorkId,
      scheme,
      activeScheme,
      activePath,
      creating,
      onSelectFile,
      requestCreate,
      deleteConfirm.requestDelete,
      onCreateDone,
      expandedEntryIds,
      toggleEntry,
      catalog,
    ],
  );

  const handleExpandedChange = (next: boolean) => {
    if (creating) onCreateDone();
    setExpanded(next);
  };

  const header = (
    <RailPaneHeader
      label={schemeLabel(scheme)}
      icon={schemeIcon(scheme)}
      expanded={expanded}
      onExpandedChange={handleExpandedChange}
      actions={
        schemeAllowsCreation(scheme) ? (
          <>
            <PaneHeaderActionButton
              icon={FilePlus}
              label={t`New file`}
              onClick={() => requestCreate("file", "")}
            />
            <PaneHeaderActionButton
              icon={FolderPlus}
              label={t`New folder`}
              onClick={() => requestCreate("folder", "")}
            />
          </>
        ) : undefined
      }
    />
  );

  return (
    <section>
      {header}
      {expanded && scheme === "unfiled" ? (
        <UnfiledPendingDocuments
          projectId={projectId}
          editorWorkId={editorWorkId}
          documents={pendingUnfiled}
        />
      ) : null}
      {expanded && catalog && env ? (
        <TreeEnvProvider value={env}>
          <div>
            <TreeChildren parentId={catalog.root.entryId} parentPath="" depth={1} />
            {/* "No context files yet." is a claim about the tree, so it waits
                for a RESOLVED tree. While the query is in flight with nothing
                cached the pane body stays blank (no spinner) — prefetch at
                mount makes that window nearly unhittable. */}
            {isError ? (
              <InlineErrorRow message={t`Couldn't load files.`} onRetry={refetch} />
            ) : catalog.children(catalog.root.entryId).length === 0 &&
              pendingUnfiled.length === 0 &&
              !creating ? (
              <EmptyHint depth={1}>
                <Trans>No context files yet.</Trans>
              </EmptyHint>
            ) : null}
          </div>
        </TreeEnvProvider>
      ) : null}
      <DeleteConfirmationDialog
        target={deleteConfirm.target}
        isPending={deleteConfirm.isPending}
        error={deleteConfirm.error}
        onCancel={deleteConfirm.cancel}
        onConfirm={deleteConfirm.confirm}
      />
    </section>
  );
}

function parentContextPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "" : path.slice(0, separator);
}

function EmptyHint({ depth, children }: { depth: number; children: React.ReactNode }) {
  return (
    <p
      className="py-1.5 pr-2 text-xs text-ink-subtle"
      style={{ paddingLeft: rowPaddingLeft(depth) }}
    >
      {children}
    </p>
  );
}
