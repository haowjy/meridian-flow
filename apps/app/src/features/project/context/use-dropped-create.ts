import type { DocumentId } from "@meridian/contracts/runtime";
import { droppedRecords } from "@meridian/project-tree";
import { useEffect, useMemo, useState } from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import type { Bounce } from "@/core/project-tree/tree-undo";
import { useAccountId, useLiveDocumentSessionRegistry } from "./account-feature-context";

/**
 * The writer's create of a document that the server dropped (its Work was closed), with what they
 * typed into it here, for the document's own tab. Read from the list, so it outlasts the row's word.
 */
export function useDroppedCreate(projectId: string, documentId: string | null): Bounce | null {
  const accountId = useAccountId();
  const project = useTreeList(documentId ? { kind: "project", projectId } : null);
  const account = useTreeList(documentId ? { kind: "account", userId: accountId } : null);
  const registry = useLiveDocumentSessionRegistry();
  const record = useMemo(
    () =>
      documentId
        ? ([project.snapshot, account.snapshot]
            .flatMap((snapshot) => (snapshot ? droppedRecords(snapshot.doc) : []))
            .find(({ record }) => record.type === "create" && record.node === documentId)?.record ??
          null)
        : null,
    [documentId, project.snapshot, account.snapshot],
  );
  const [typed, setTyped] = useState<{ record: string; text: string | null } | null>(null);
  const recordId = record?.id ?? null;
  const node = record?.node ?? null;
  useEffect(() => {
    if (!recordId || !node) return;
    let current = true;
    void registry.localText(node as DocumentId).then((text) => {
      if (current) setTyped({ record: recordId, text });
    });
    return () => {
      current = false;
    };
  }, [registry, recordId, node]);
  return record ? { record, typed: typed?.record === record.id ? typed.text : null } : null;
}
