/**
 * Toasts a Move, Copy or delete the server refused, with Retry. On screen the row has already
 * gone back and carries its own mark where it has one. A refused Copy is also resolved here: its
 * rows are gone and nothing else would clear it from the journal. A row refused before this tab
 * opened is left to that mark.
 */
import { t } from "@lingui/core/macro";
import {
  projectFolderNeedsRepair,
  projectResourceNeedsRepair,
  type ResourceDestination,
} from "@meridian/resource-replica";
import { useEffect, useRef } from "react";
import { refusedMoveDestination } from "@/client/query/context-catalog-projection";
import { notifyFailure } from "@/components/app/failure-toast";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
} from "../account-feature-context";
import { schemeLabel } from "../context-schemes";
import { deleteEntry } from "../use-delete-context-entry";
import { copyRefusals } from "./copy-refusal";
import { ENTRY_FAILURE_TOAST, type EntryRef } from "./entry";
import { copyRows } from "./execute-copy";
import { moveRows } from "./execute-move";
import { entryNameNow, type PlacementView } from "./move-plan";

type Repair = {
  intentId: string;
  kind: "set-location" | "delete" | "create";
  name: string;
  destination?: ResourceDestination;
};

const placeName = (view: PlacementView, { parent }: ResourceDestination) =>
  parent.kind === "root"
    ? schemeLabel(parent.scheme)
    : (view.placement.folderLocation(parent.folderId)?.name ?? null);

export function RefusalToasts({ projectId }: { projectId: string }) {
  const resources = useAccountResourceReplica();
  const { records, folders, placement, snapshot } = useAccountResourceProjection(projectId);
  const said = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const context = { resources, projectId };
    const view = { records, folders, placement, operations: snapshot.operations };
    const refused = (
      entry: EntryRef,
      repair: Repair | null,
      current: ReturnType<typeof placement.parentForFolder>,
    ) => {
      if (!repair) return [];
      const name = entryNameNow(view, entry) ?? repair.name;
      if (repair.kind === "delete")
        return [
          {
            intentId: repair.intentId,
            title: t`Couldn't delete ${name}.`,
            retry: () => void deleteEntry(resources, projectId, entry),
          },
        ];
      const destination = refusedMoveDestination(repair.destination, current);
      if (repair.kind !== "set-location" || !destination || !current) return [];
      const to = placeName(view, destination);
      return [
        {
          intentId: repair.intentId,
          title: to ? t`Couldn't move ${name} to ${to}.` : t`Couldn't move ${name}.`,
          retry: () =>
            void moveRows(
              [
                {
                  entry,
                  name,
                  typed: destination.name,
                  before: current,
                  after: destination.parent,
                  ...(destination.position ? { position: destination.position } : {}),
                },
              ],
              context,
            ),
        },
      ];
    };
    const refusals = [
      ...records.flatMap((record) => {
        const documentId = record.resource.identity?.documentId;
        return documentId
          ? refused(
              { kind: "file", id: documentId },
              projectResourceNeedsRepair(projectId, record),
              placement.parentForResource(record),
            )
          : [];
      }),
      ...folders.flatMap((folder) =>
        refused(
          { kind: "folder", id: folder.folderId },
          projectFolderNeedsRepair(folder),
          placement.parentForFolder(folder.folderId),
        ),
      ),
    ];
    const first = said.current === null;
    const seen = said.current ?? new Set<string>();
    said.current = seen;
    for (const { intentId, title, retry } of refusals) {
      if (seen.has(intentId)) continue;
      seen.add(intentId);
      if (!first) notifyFailure({ key: ENTRY_FAILURE_TOAST, title, onRetry: retry });
    }
    for (const { operationId, message, copy } of copyRefusals(view, projectId)) {
      if (seen.has(operationId)) continue;
      seen.add(operationId);
      notifyFailure({
        key: ENTRY_FAILURE_TOAST,
        title: message,
        onRetry: copy ? () => void copyRows(copy, context) : undefined,
      });
      void resources.resolveCopyRefusal(operationId);
    }
  }, [records, folders, placement, snapshot, projectId, resources]);
  return null;
}
