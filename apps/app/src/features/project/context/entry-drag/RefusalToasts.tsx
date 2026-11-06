/**
 * Toasts what the server refused. A refused Move or delete has its mark on the row, so its toast
 * groups the rows refused together and a newer one replaces it; a row refused before this project
 * opened is left to that mark. A refused Copy has no row left, so each keeps its own toast, and it
 * stays in the journal until the writer closes that toast or Retry lands. Every toast closes once
 * what it reports is no longer refused, and on leaving the project.
 */
import { useEffect, useRef } from "react";
import { dismissFailure, notifyFailure } from "@/components/app/failure-toast";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
  useOptionalRemovedNotices,
} from "../account-feature-context";
import { type CopyRefusal, copyRefusals } from "./copy-refusal";
import {
  ENTRY_FAILURE_TOAST,
  type EntryContext,
  entryRefusals,
  retryCopyRefusal,
  retryRefusals,
} from "./entry-failure";

const copyToast = (operationId: string) => `copy-refusal:${operationId}`;

export function RefusalToasts({ projectId }: { projectId: string }) {
  const resources = useAccountResourceReplica();
  const notices = useOptionalRemovedNotices();
  const { records, folders, placement, snapshot } = useAccountResourceProjection(projectId);
  /** Intents with no toast to come: refused before this mount, closed, retried or replaced. */
  const settled = useRef<Set<string> | null>(null);
  const shownRows = useRef<{ group: string; intents: ReadonlySet<string> } | null>(null);
  const shownCopies = useRef(new Set<string>());

  useEffect(() => {
    if (!snapshot) return;
    const context: EntryContext = { resources, projectId, notices };
    const view = { records, folders, placement, operations: snapshot.operations };

    const refused = entryRefusals(view, projectId);
    settled.current ??= new Set(refused.map(({ intentId }) => intentId));
    const done = settled.current;
    const open = refused.filter(({ intentId }) => !done.has(intentId));
    const shown = shownRows.current;
    const fresh = open.filter(({ intentId }) => !shown?.intents.has(intentId)).at(-1);
    const group = fresh?.group ?? shown?.group;
    const members = open.filter((row) => row.group === group);
    for (const { intentId } of open)
      if (!members.some((row) => row.intentId === intentId)) done.add(intentId);
    if (members.length === 0) {
      if (shown) dismissFailure(ENTRY_FAILURE_TOAST);
      shownRows.current = null;
    } else if (group && (fresh || members.length !== shown?.intents.size)) {
      const intents = new Set(members.map(({ intentId }) => intentId));
      const close = () => {
        for (const intentId of intents) done.add(intentId);
        shownRows.current = null;
      };
      dismissFailure(ENTRY_FAILURE_TOAST);
      shownRows.current = { group, intents };
      notifyFailure({
        key: ENTRY_FAILURE_TOAST,
        title: members[0]?.title(members) ?? "",
        onClose: close,
        onRetry: async () => {
          close();
          await retryRefusals(context, intents);
        },
      });
    }

    const copies = copyRefusals(view, projectId);
    const showCopy = ({ operationId, message, copy }: CopyRefusal) =>
      notifyFailure({
        key: copyToast(operationId),
        title: message,
        onClose: () => void resources.resolveCopyRefusal(operationId),
        onRetry: copy
          ? () =>
              retryCopyRefusal(context, operationId, () => showCopy({ operationId, message, copy }))
          : undefined,
      });
    for (const refusal of copies) {
      if (shownCopies.current.has(refusal.operationId)) continue;
      shownCopies.current.add(refusal.operationId);
      showCopy(refusal);
    }
    for (const operationId of shownCopies.current) {
      if (copies.some((refusal) => refusal.operationId === operationId)) continue;
      shownCopies.current.delete(operationId);
      dismissFailure(copyToast(operationId));
    }
  }, [records, folders, placement, snapshot, projectId, resources, notices]);

  useEffect(
    () => () => {
      dismissFailure(ENTRY_FAILURE_TOAST);
      for (const operationId of shownCopies.current) dismissFailure(copyToast(operationId));
      shownCopies.current.clear();
      shownRows.current = null;
      settled.current = null;
    },
    [],
  );
  return null;
}
