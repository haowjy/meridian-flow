import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { useDocumentTrash } from "@/client/query/useDocumentTrash";
import { cn } from "@/lib/utils";
import { TrashListPane } from "../../context/DocumentTrashDialog";
import { useDocumentTrashRestore } from "../../context/DocumentTrashRestoreProvider";
import { useDeleteContextEntry } from "../../context/use-delete-context-entry";
import { useProjectTrashNavigation } from "../../routing/ProjectNavigationContext";
import { acceptEntryDrag, draggedEntries } from "./trash-drop";

/**
 * Trash as a source: deleted documents, newest first. Rows dropped anywhere on
 * it are deleted at once. Picking a document opens its preview with Restore.
 */
export function TrashSource({ projectId }: { projectId: string }) {
  const query = useDocumentTrash(projectId);
  const { states, restore } = useDocumentTrashRestore();
  const { navigate } = useProjectTrashNavigation();
  const deletion = useDeleteContextEntry(projectId);
  const [over, setOver] = useState(false);
  const entries = query.data?.documents ?? [];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop is a pointer shortcut for each row's Delete.
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col rounded-md transition-colors",
        over && "bg-sidebar-accent ring-1 ring-border-focus ring-inset",
      )}
      onDragOver={(event) => setOver(acceptEntryDrag(event))}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        deletion.deleteEntries(draggedEntries());
      }}
    >
      <p className="px-4 pt-1 pb-1 text-[13px] font-semibold">
        <Trans>Trash</Trans>
      </p>
      <TrashListPane
        entries={entries}
        query={query}
        selectedId={undefined}
        states={states}
        onSelect={(documentId) => void navigate(documentId)}
        onRestore={restore}
        className="flex-1"
      />
    </div>
  );
}
