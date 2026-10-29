/**
 * The phone's document screen has no identity bar, so a document whose create or move the server
 * refused says so here, above the page, with Move… and Rename to repair it. It reads the same
 * catalog row the Files list shows and drives the same entry interaction, so a repair here is the
 * repair that row offers.
 */
import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import type { EditableContextTab } from "../context/ContextDocumentHost";
import { parentContextEntryPath } from "../context/context-entry-name";
import { EntryDestinationPicker } from "../context/EntryDestinationPicker";
import { EntryNameField } from "../context/EntryNameField";
import { EntryRefusalNotice } from "../context/EntryRefusalNotice";
import { OperationFeedbackProvider } from "../context/entry-drag/operation-notice";
import { useEntryInteraction } from "../context/use-entry-interaction";
import { useRenameEntryForm } from "../context/use-rename-entry-form";

export function MobileRefusalNotice({
  projectId,
  tab,
  className,
}: {
  projectId: string;
  tab: EditableContextTab;
  className?: string;
}) {
  // A refused nameless create is listed in Unfiled, like any refused create.
  const scheme = tab.kind === "tracked" ? tab.scheme : "unfiled";
  const owner: ContextOwner =
    tab.kind === "tracked" && tab.rootThreadId
      ? { rootThreadId: tab.rootThreadId, rootThreadRef: tab.rootThreadRef }
      : { workId: tab.kind === "tracked" ? tab.workId : undefined };
  const { catalog } = useContextCatalogView(projectId, scheme, owner);
  const file = catalog?.findDocument(tab.documentId) ?? null;
  if (!catalog || !file?.namespaceFailure) return null;
  return (
    <RefusedDocument
      projectId={projectId}
      scheme={scheme}
      owner={owner}
      catalog={catalog}
      file={file}
      className={className}
    />
  );
}

function RefusedDocument({
  projectId,
  scheme,
  owner,
  catalog,
  file,
  className,
}: {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  catalog: CatalogContextView;
  file: CatalogFile;
  className?: string;
}) {
  const parentPath = parentContextEntryPath(file.path);
  const parent = parentPath ? catalog.findPath(parentPath) : catalog.root;
  const interaction = useEntryInteraction({
    projectId,
    node: file,
    owner,
    scheme,
    capabilities: ["rename", "move"],
    onRequestDelete: () => undefined,
    siblings: parent?.kind === "dir" ? catalog.children(parent.entryId) : [],
  });
  // Move… publishes its operation under the phone's surface, as the Files list does.
  return (
    <OperationFeedbackProvider feedback={{ surface: "mobile" }}>
      <EntryDestinationPicker {...interaction.picker}>
        <div className={className}>
          {interaction.renaming ? (
            <RenameField options={interaction.rename} />
          ) : file.namespaceFailure ? (
            <EntryRefusalNotice
              failure={file.namespaceFailure}
              move={Boolean(file.namespaceRepairMove)}
              actions={interaction.actions}
              onAction={interaction.onAction}
            />
          ) : null}
        </div>
      </EntryDestinationPicker>
    </OperationFeedbackProvider>
  );
}

function RenameField({ options }: { options: Parameters<typeof useRenameEntryForm>[0] }) {
  const form = useRenameEntryForm(options);
  return <EntryNameField form={form} label={t`Rename`} className="min-h-11" />;
}
