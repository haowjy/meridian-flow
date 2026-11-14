/**
 * The phone's document screen has no identity bar, so a document whose create or move the server
 * refused says so here, above the page, with Move… and Rename to repair it. It reads the same
 * tree row the Files list shows and drives the same entry interaction, so a repair here is the
 * repair that row offers.
 */
import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useProjectTreeView } from "@/client/query/useProjectTree";
import type { TreeFile, TreeView } from "@/core/project-tree/tree-view";
import type { EditableOpenDocument } from "../context/ContextDocumentHost";
import { EntryDestinationPicker } from "../context/EntryDestinationPicker";
import { EntryNameField } from "../context/EntryNameField";
import { EntryRefusalNotice } from "../context/EntryRefusalNotice";
import { useEntryInteraction } from "../context/use-entry-interaction";
import { useRenameEntryForm } from "../context/use-rename-entry-form";

export function MobileRefusalNotice({
  projectId,
  document,
  className,
}: {
  projectId: string;
  document: EditableOpenDocument;
  className?: string;
}) {
  // A refused nameless create is listed in Unfiled, like any refused create.
  const scheme = document.kind === "tracked" ? document.scheme : "unfiled";
  const owner: ContextOwner =
    document.kind === "tracked" && document.rootThreadId
      ? { rootThreadId: document.rootThreadId, rootThreadRef: document.rootThreadRef }
      : { workId: document.kind === "tracked" ? document.workId : undefined };
  const { tree } = useProjectTreeView(projectId, scheme, {
    workId: owner.workId,
    rootThreadId: owner.rootThreadId,
  });
  const file = tree?.findDocument(document.documentId) ?? null;
  if (!tree || !file?.namespaceFailure) return null;
  return (
    <RefusedDocument
      projectId={projectId}
      scheme={scheme}
      owner={owner}
      tree={tree}
      file={file}
      className={className}
    />
  );
}

function RefusedDocument({
  projectId,
  scheme,
  owner,
  tree,
  file,
  className,
}: {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  tree: TreeView;
  file: TreeFile;
  className?: string;
}) {
  const interaction = useEntryInteraction({
    projectId,
    node: file,
    owner,
    scheme,
    capabilities: ["rename", "move"],
    onRequestDelete: () => undefined,
    siblings: tree.children(file.parentId),
  });
  return (
    <EntryDestinationPicker {...interaction.picker}>
      <div className={className}>
        {interaction.renaming ? (
          <RenameField options={interaction.rename} />
        ) : file.namespaceFailure ? (
          <EntryRefusalNotice
            failure={file.namespaceFailure}
            move={Boolean(file.namespaceRepairMove)}
            reason={file.failureReason}
            actions={interaction.actions}
            onAction={interaction.onAction}
          />
        ) : null}
      </div>
    </EntryDestinationPicker>
  );
}

function RenameField({ options }: { options: Parameters<typeof useRenameEntryForm>[0] }) {
  const form = useRenameEntryForm(options);
  return <EntryNameField form={form} label={t`Rename`} className="min-h-11" />;
}
