import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useDocumentTrash } from "@/client/query/useDocumentTrash";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { ListLine } from "@/components/ui/list-row";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { TrashRow } from "../../context/DocumentTrashDialog";
import { useDocumentTrashRestore } from "../../context/DocumentTrashRestoreProvider";
import { useProjectTrashNavigation } from "../../routing/ProjectNavigationContext";
import { type SourceDrop, SourcePane } from "./SourcePane";

/**
 * Trash as a source: deleted documents, newest first. Rows dropped on it are
 * deleted at once; its rows drag out to be restored where they land. Picking
 * one opens its preview with Restore.
 */
export function TrashSource({
  projectId,
  onPicked,
  drop,
}: {
  projectId: string;
  onPicked?: () => void;
  drop: SourceDrop;
}) {
  const query = useDocumentTrash(projectId);
  const { states, restore } = useDocumentTrashRestore();
  const { navigate } = useProjectTrashNavigation();
  const now = useMinuteClock();
  const entries = query.data?.documents ?? [];
  return (
    <SourcePane label={t`Trash`} drop={drop}>
      {entries.map((entry) => (
        <TrashRow
          key={entry.documentId}
          entry={entry}
          now={now}
          selected={false}
          state={states.get(entry.documentId)}
          onOpen={() => {
            void navigate(entry.documentId);
            onPicked?.();
          }}
          onRestore={(ids) => restore(entries.filter(({ documentId }) => ids.includes(documentId)))}
        />
      ))}
      {query.isError ? (
        <InlineErrorRow message={t`Couldn't load Trash.`} onRetry={() => void query.refetch()} />
      ) : entries.length > 0 ? null : (
        <div className="px-2">
          {query.isPending ? (
            <ListLine iconSlot status>
              <Trans>Loading Trash…</Trans>
            </ListLine>
          ) : (
            <ListLine iconSlot>
              <Trans>Nothing in the trash.</Trans>
            </ListLine>
          )}
        </div>
      )}
    </SourcePane>
  );
}
